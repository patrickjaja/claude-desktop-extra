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
// ---- Renderer half (ion-dist, 3P mode): add_feature_auto_archive_grace_ion ----
const ionBinary = path.join(ROOT, "patches/community/add_feature_auto_archive_grace_ion");
const ION_TARGET = "This session will be archived automatically after you leave it.";
// Shapes of upstream 4.16336.0's two target chunks; names, slot counts and
// each chunk's local import aliases changed.
const noticeFixture = [
  'import{Ga as jx,Ka as jxs,Wa as Frag,To as st,go as eff,wo as rf}from"./vendor-frame-test.js";',
  'function Pref(e){let $=Q7(4),[t,n]=st(),r,i;return J1($,0,e)?(r=()=>{if(!e)return;let t=e=>{n(e.ccAutoArchiveOnPrClose===!0)};return Zn?.getPreferences?.().then(t,lje),Zn?.onPreferencesChanged?.(t)},i=[e],K2($,0,e,r,i)):(r=$[1],i=$[2]),eff(r,i),t}',
  'function Note(e){let $=Q7(8),{hold:t,sessionRef:n}=e,r=Vu();return jx("div",{role:"status","aria-live":"polite","data-find-omitted":"",className:`max-w-full ${gv} ${uv}`,children:"' + ION_TARGET + '"})}',
  'function Row(e,t){let $=Q7(441),{repoKey:n,sessionRef:r,sessionRepo:i,isPrimary:a,inRail:D}=e;return J5($,434,u,d,c,p,m,g)?K5($,434,u,d,c,p,m,g,jxs(Frag,{children:[u,d,c,p,m,g]})):$[440]}'
].join("\n");
const railFixture = [
  'import{Ga as o,Ka as c,Wa as u,To as l,go as h}from"./vendor-frame-test.js";',
  'function Side(e){let $=Q7(124),{session:t,pullRequests:n,plan:r,artifacts:i,repoMenuItems:a,outputsSession:s,controls:k}=e;let x=o(Vb,{id:"environment",title:"Environment"}),z=o(Vb,{id:"pullRequests",title:"Changes"});if(!t)return null;let je="header",We="content";return J4($,118,ke,Ae,je,We)?K4($,118,ke,Ae,je,We,c("aside",{ref:De,"aria-label":ke,tabIndex:-1,onMouseDownCapture:Km,onClickCapture:Km,onDoubleClickCapture:Km,className:Ae,children:[je,We]})):$[122]}function After(){}'
].join("\n");
function runIon(notice, rail) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-grace-ion-")), assets = path.join(dir, "assets/v1");
  fs.mkdirSync(assets, { recursive: true });
  const noticeFile = path.join(assets, "notice.js"), railFile = path.join(assets, "rail.js");
  fs.writeFileSync(noticeFile, notice); fs.writeFileSync(railFile, rail);
  const run = spawnSync(ionBinary, [dir], { encoding: "utf8" });
  return { dir, noticeFile, railFile, run };
}
function checkIon(notice, rail) {
  const first = runIon(notice, rail);
  try {
    assert.equal(first.run.status, 0, first.run.stdout + first.run.stderr);
    for (const file of [first.noticeFile, first.railFile]) execFileSync(process.execPath, ["--check", file]);
    const out = { notice: fs.readFileSync(first.noticeFile, "utf8"), rail: fs.readFileSync(first.railFile, "utf8") };
    const again = spawnSync(ionBinary, [first.dir], { encoding: "utf8" });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(fs.readFileSync(first.noticeFile, "utf8"), out.notice, "second run must be byte-identical");
    assert.equal(fs.readFileSync(first.railFile, "utf8"), out.rail, "second run must be byte-identical");
    return out;
  } finally { fs.rmSync(first.dir, { recursive: true, force: true }); }
}
const noImports = text => text.replace(/^import\{[^}]*\}from"[^"]*";/, "");
await test("ion patch: applies to upstream's shapes with renamed aliases and slot counts, node --check, idempotent", async () => {
  const out = checkIon(noticeFixture, railFixture);
  assert.match(out.notice, /function Note\(e\)\{return jx\(__cdbArchiveGraceView,\{sessionRef:e\.sessionRef,hold:e\.hold,lineClass:`max-w-full \$\{gv\} \$\{uv\}`,children:jx\(__cdbArchiveNativeNotice,e\)\}\)\}/);
  for (const alias of ["= st(null)", "eff(() =>", "jxs(Frag, {children:"]) assert.ok(out.notice.includes(alias), "notice helper uses " + alias);
  // The rail chunk gets its own local names for the same vendor exports.
  for (const alias of ["= l(null)", "h(() =>", "c(u, {children:"]) assert.ok(out.rail.includes(alias), "rail helper uses " + alias);
  assert.match(out.rail, /return __cdbRail&&Array\.isArray\(__cdbRail\.props\?\.children\)\?c\(__cdbRail\.type,/);
  for (const text of [out.notice, out.rail]) assert.ok(!/__cdb(ReactState|ReactEffect|JsxOne|JsxMany|Fragment)\b/.test(text));
});
await test("ion patch: fails closed on changed anchors, a missing chunk and a stale injection", async () => {
  const out = checkIon(noticeFixture, railFixture);
  const broken = [
    [noticeFixture.replace("onPreferencesChanged", "onPrefs"), railFixture],
    [noticeFixture.replace("{hold:t,sessionRef:n}", "{reason:t,sessionRef:n}"), railFixture],
    [noticeFixture.replace("isPrimary:a", "primary:a"), railFixture],
    [noticeFixture.replace("Ka as jxs", "Ka as jxz"), railFixture],
    [noticeFixture, railFixture.replace("Ka as c,", "")],
    [noticeFixture, railFixture.replace("vendor-frame-test", "vendor-frame-other")],
    [noticeFixture, railFixture.replace("outputsSession:s", "changed:s")],
    [noticeFixture, railFixture.replace('c("aside"', 'o("aside"')],
    [noticeFixture, railFixture.replace("children:[je,We]", "children:je")],
    [noticeFixture, railFixture.replace("if(!t)return null;", "if(!t)return t;")],
    [noticeFixture, railFixture.replace('id:"pullRequests"', 'id:"prs"')],
    [out.notice, out.rail.replace("rail:!0", "rail:!1")],
    [out.notice.replace("setSessionAutoArchiveOnPrClose(id, false)", "changed(id, false)"), out.rail]
  ];
  for (const [notice, rail] of broken) {
    const r = runIon(notice, rail);
    try { assert.notEqual(r.run.status, 0, "must fail"); assert.match(r.run.stdout + r.run.stderr, /\[FAIL\]/); }
    finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  }
});
await test("ion wrappers: the keep control is appended inside the rail's aside, ref/key kept; the notice wrapper passes hold and class", async () => {
  const out = checkIon(noticeFixture, railFixture);
  const ctx = { o: (type, props, key) => ({ type, props, key: key ?? null }), c: (type, props, key) => ({ type, props, key: key ?? null }),
    u: "Fragment", l: () => [null, () => {}], h: () => {}, Q7: () => [], J4: () => true, K4: (...a) => a.at(-1),
    Vb: "section", De: { current: null }, ke: "Session details", Km() {}, Ae: "rail" };
  vm.runInNewContext(noImports(out.rail) + "\nglobalThis.Side=Side;globalThis.setNative=f=>{__cdbArchiveNativeRail=f};", ctx);
  const sessionRef = { type: "local", id: "s" };
  const aside = ctx.Side({ session: {}, outputsSession: sessionRef });
  assert.equal(aside.type, "aside"); assert.equal(aside.props.ref, ctx.De, "ref is a prop in React 19 and survives the clone");
  assert.deepEqual(Array.from(aside.props.children.slice(0, 2)), ["header", "content"], "upstream children first, unchanged");
  assert.equal(aside.props.children[2].props.sessionRef, sessionRef); assert.equal(aside.props.children[2].props.rail, true);
  assert.equal(ctx.Side({ session: null, outputsSession: sessionRef }), null);
  ctx.setNative(() => ({ type: "aside", props: { children: "single" }, key: null }));
  assert.equal(ctx.Side({ outputsSession: sessionRef }).props.children, "single", "non-array children: returned as is");
  ctx.setNative(() => ({ type: "aside", props: { children: ["a"] }, key: "k" }));
  assert.equal(ctx.Side({ outputsSession: sessionRef }).key, "k");
  const nctx = { jx: (type, props) => ({ type, props }), gv: "g", uv: "u", st: () => [null, () => {}], eff: () => {} };
  vm.runInNewContext(noImports(out.notice) + "\nglobalThis.Note=Note;", nctx);
  const note = nctx.Note({ hold: { reason: "pinned" }, sessionRef });
  assert.deepEqual(note.props.hold, { reason: "pinned" }); assert.equal(note.props.lineClass, "max-w-full g u");
  assert.equal(note.props.children.props.hold.reason, "pinned", "upstream's notice gets its own props");
});
// The real target chunks from a pristine extract: CDB_ION_DIST (an ion-dist
// directory or ion-dist.asar), else tmp/extract's resources/ion-dist.asar.
const isRailChunk = buf => buf.includes('id:"environment",title:') && buf.includes('id:"pullRequests",title:') && buf.includes("outputsSession:");
function readAsarChunks(file) {
  const fd = fs.openSync(file, "r"), found = {};
  try {
    const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12)); fs.readSync(fd, json, 0, json.length, 16);
    const base = 8 + head.readUInt32LE(4);
    const dir = JSON.parse(json.toString("utf8")).files?.assets?.files?.v1?.files || {};
    for (const [name, entry] of Object.entries(dir)) {
      if (!name.endsWith(".js") || entry.unpacked || !entry.size) continue;
      const buf = Buffer.alloc(entry.size); fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
      if (buf.includes(ION_TARGET)) found.notice = { name, buf };
      if (isRailChunk(buf)) found.rail = { name, buf };
    }
  } finally { fs.closeSync(fd); }
  return found;
}
function pristineIonChunks() {
  const candidates = [process.env.CDB_ION_DIST, path.join(ROOT, "tmp/extract/usr/lib/claude-desktop/resources/ion-dist.asar")].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (fs.statSync(candidate).isFile()) return { from: candidate, ...readAsarChunks(candidate) };
    const assets = path.join(candidate, "assets/v1"), found = { from: candidate };
    for (const name of fs.existsSync(assets) ? fs.readdirSync(assets) : []) {
      if (!name.endsWith(".js")) continue;
      const buf = fs.readFileSync(path.join(assets, name));
      if (buf.includes(ION_TARGET)) found.notice = { name, buf };
      if (isRailChunk(buf)) found.rail = { name, buf };
    }
    return found;
  }
  return null;
}
{
  const real = pristineIonChunks();
  if (!real || !real.notice || !real.rail) console.log("SKIP ion patch on the real chunks: " + (real ? "target chunks not found in " + real.from : "no pristine ion-dist (set CDB_ION_DIST or extract to tmp/extract)"));
  else if (real.notice.buf.includes("__cdb") || real.rail.buf.includes("__cdb")) console.log("SKIP ion patch on the real chunks: " + real.from + " is already patched");
  else await test(`ion patch: applies to the real pristine chunks (${real.notice.name}, ${real.rail.name}), node --check, idempotent`, async () => {
    const out = checkIon(real.notice.buf, real.rail.buf);
    for (const text of [out.notice, out.rail]) assert.equal(text.split("/*cdb-archive-grace-ui*/").length, 2);
    assert.ok(out.notice.includes("function __cdbArchiveNativeNotice(") && out.rail.includes("function __cdbArchiveNativeRail("));
  });
}
await test("status projects only the effective persisted deadline, from a fresh delay read", async () => {
  const h = harness();
  assert.equal((await h.api.status("s")).deadline, null);
  await h.wait();
  assert.equal((await h.api.status("s")).deadline, 1000000 + 15 * 60000);
  h.minutes(30);
  assert.equal((await h.api.status("s")).deadline, 1000000 + 30 * 60000);
  h.api.begin(); h.minutes(45);
  assert.equal((await h.api.status("s")).deadline, 1000000 + 45 * 60000, "not the sweep snapshot");
  h.session.autoArchiveOnPrClose = false;
  assert.equal((await h.api.status("s")).enabled, false);
  h.session.autoArchiveOnPrClose = true; h.session.prs[0].state = "OPEN";
  assert.equal((await h.api.status("s")).terminal, false);
  h.minutes(0); assert.equal((await h.api.status("s")).active, false);
});
// A minimal hook host for js/auto_archive_grace_ui.js: slot state, effects
// run by hand, counted intervals.
function uiHost({ read, noBridge = false, noSessions = false } = {}) {
  const ui = fs.readFileSync(path.join(ROOT, "js/auto_archive_grace_ui.js"), "utf8");
  const host = { values: [], effects: [], intervals: new Map(), reads: [], saved: [], now: 1000000, nextId: 1 };
  let slot = 0;
  const context = {
    __cdbReactState: initial => { const n = slot++; if (!(n in host.values)) host.values[n] = initial; return [host.values[n], value => { host.values[n] = value; }]; },
    __cdbReactEffect: (fn, deps) => host.effects.push({ fn, deps }),
    __cdbJsxOne: (type, props) => ({ type, props }),
    __cdbJsxMany: (type, props) => ({ type, props, many: true }),
    __cdbFragment: "Fragment",
    Date: { now: () => host.now }, Number, Math, String,
    setInterval: (fn, ms) => { const id = host.nextId++; host.intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => { host.intervals.delete(id); }
  };
  if (!noSessions) context["claude.web"] = { LocalSessions: { setSessionAutoArchiveOnPrClose: async (...args) => { host.saved.push(args); } } };
  if (!noBridge) context.cdbExtra = { autoArchiveGraceRead: async id => { host.reads.push(id); return typeof read === "function" ? read() : read; } };
  const view = vm.runInNewContext(ui + "\n__cdbArchiveGraceView", context);
  host.render = (props = {}) => { slot = 0; host.effects = []; return view({ sessionRef: { type: "local", id: "s" }, lineClass: "notice-class", children: "native notice", ...props }); };
  host.flush = () => new Promise(r => setImmediate(r));
  host.mount = async (props = {}) => { host.render(props); const cleanup = host.effects[0].fn(); await host.flush(); return cleanup; };
  host.poll = async () => { await [...host.intervals.values()][0].fn(); await host.flush(); };
  return host;
}
const texts = node => node == null || typeof node !== "object" ? [String(node)] : [].concat(node.props?.children ?? []).flatMap(texts);
const roles = node => node == null || typeof node !== "object" ? [] : [node.props?.role, ...[].concat(node.props?.children ?? []).flatMap(roles)].filter(Boolean);
await test("renderer: delay Immediately, PR rule off or no bridge -> one read at most, no interval, upstream output unchanged", async () => {
  for (const read of [{ ok: true, active: false }, { ok: true, active: true, enabled: false }, null, { ok: false, error: "x" }]) {
    const h = uiHost({ read });
    const cleanup = await h.mount({ hold: { reason: "on_screen" } });
    assert.equal(h.reads.length, 1); assert.equal(h.intervals.size, 0, "no interval for " + JSON.stringify(read));
    assert.equal(h.render({ hold: { reason: "on_screen" } }), "native notice");
    assert.equal(h.render({ rail: true }), null);
    cleanup();
  }
  const h = uiHost({ noBridge: true });
  await h.mount(); assert.equal(h.intervals.size, 0); assert.equal(h.render(), "native notice");
  const remote = uiHost({ read: { ok: true, active: true, enabled: true, terminal: true, deadline: 2000000 } });
  await remote.mount({ sessionRef: { type: "remote", id: "r" } });
  assert.equal(remote.reads.length, 0); assert.equal(remote.intervals.size, 0);
  assert.equal(remote.render({ sessionRef: { type: "remote", id: "r" } }), "native notice");
});
await test("renderer: an open PR (enabled, not terminal) polls but leaves the notice and rail unchanged", async () => {
  const h = uiHost({ read: { ok: true, active: true, enabled: true, terminal: false } });
  const cleanup = await h.mount();
  assert.equal(h.intervals.size, 1); assert.equal([...h.intervals.values()][0].ms, 30000);
  assert.equal(h.render(), "native notice"); assert.equal(h.render({ rail: true }), null);
  cleanup(); assert.equal(h.intervals.size, 0, "unmount clears the poll");
});
await test("renderer: terminal PR appends a coarse line after upstream's notice, outside any live region", async () => {
  let answer = { ok: true, active: true, enabled: true, terminal: true, deadline: 1000000 + 12 * 60000 - 5000 };
  const h = uiHost({ read: () => answer });
  const cleanup = await h.mount({ hold: { reason: "pinned" } });
  const out = h.render({ hold: { reason: "pinned" } });
  assert.equal(out.type, "Fragment"); assert.equal(out.props.children[0], "native notice", "upstream notice first, unchanged");
  const line = out.props.children[1];
  assert.equal(line.props["aria-live"], "off"); assert.equal(line.props.className, "notice-class");
  assert.deepEqual(roles(out), [], "no role=status in our output");
  assert.match(texts(line).join(""), /about 12 min left/);
  assert.equal(h.render({ sessionRef: { type: "local", id: "other" } }), "native notice", "never another session's status");
  answer = { ...answer, deadline: 1000000 + 125 * 60000 }; await h.poll();
  assert.match(texts(h.render().props.children[1]).join(""), /about 2 h 5 min left/);
  h.now = answer.deadline; await h.poll();
  assert.match(texts(h.render().props.children[1]).join(""), /delay has ended/);
  answer = { ...answer, deadline: null }; await h.poll();
  assert.match(texts(h.render().props.children[1]).join(""), /starts at the next archive sweep/);
  assert.equal(h.intervals.size, 1, "one poll, no per-second tick");
  answer = { ok: true, active: false }; await h.poll();
  assert.equal(h.intervals.size, 0, "poll stops once the delay is Immediately");
  assert.equal(h.render(), "native notice");
  cleanup();
});
await test("renderer: keep control only when terminal, writes only this session's setting and stays hidden after a stale read", async () => {
  const terminal = { ok: true, active: true, enabled: true, terminal: true, deadline: 2000000 };
  const noApi = uiHost({ read: terminal, noSessions: true });
  await noApi.mount({ rail: true }); assert.equal(noApi.render({ rail: true }), null);
  const open = uiHost({ read: { ...terminal, terminal: false } });
  await open.mount({ rail: true }); assert.equal(open.render({ rail: true }), null);
  const h = uiHost({ read: terminal });
  const cleanup = await h.mount({ rail: true });
  const box = h.render({ rail: true });
  assert.deepEqual(roles(box), [], "no role=status");
  const button = box.props.children[0];
  assert.equal(button.type, "button"); assert.match(button.props.title, /same setting/);
  await button.props.onClick();
  assert.deepEqual(h.saved, [["s", false]]);
  await h.poll();
  assert.equal(h.render({ rail: true }), null, "a read still reporting the old value cannot bring the button back");
  cleanup();
});
console.log(`${passed} archive-grace tests passed`);
