#!/usr/bin/env node
// Profile-local grace state + compiled native pipeline + settings/IPC validation,
// the ion-dist (3P) renderer half and the claude.ai (1P) page half.
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
  return { api, restart, session, engine, disk, file, logs, g: context.globalThis,
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
      fs.writeFileSync(file, 'function FHa(e=[]){let t=G().type==="3p"&&ou()==="1p"?[...e,j$t]:e;a.app.isPackaged?Mj(!0,t):fj(t)}\n' + 'var Hrr,Urr;function Yrr(){return Urr??=(async()=>{let t,n,r,s;return Hrr={qemuPath:t,firmwarePath:n,virtiofsdPath:r,virtiofsdAptInstallable:!0,kvm:s},Hrr})(),Urr}function Xrr(){return Hrr}\n' + 'function nav0(){let Uy=go(Hy,"Navigation",Xy,{events:[["navigate",[["path",I]]]]});return Uy}\n');
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
// ---- 1P half (claude.ai Code page): add_feature_auto_archive_grace_web ----
const require2 = createRequire(import.meta.url);
const webBinary = path.join(ROOT, "patches/community/add_feature_auto_archive_grace_web");
function runWeb(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-grace-web-")), file = path.join(dir, "index.js");
  fs.writeFileSync(file, text);
  const run = spawnSync(webBinary, [file], { encoding: "utf8" });
  const out = fs.readFileSync(file, "utf8"); fs.rmSync(dir, { recursive: true, force: true });
  return { run, out };
}
function checkWeb(text) {
  const first = runWeb(text);
  assert.equal(first.run.status, 0, first.run.stdout + first.run.stderr);
  assert.equal(first.out.split("/*__CDB_ARCHIVE_GRACE_WEB__*/").length, 2, "one injection");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-grace-web-")), file = path.join(dir, "index.js");
  try {
    fs.writeFileSync(file, first.out); execFileSync(process.execPath, ["--check", file]);
    // A later prefix injection (panel tabs) lands between ours and the prologue.
    fs.writeFileSync(file, first.out.replace('"use strict";', '"use strict";/*other*/;'));
    const again = spawnSync(webBinary, [file], { encoding: "utf8" });
    assert.equal(again.status, 0, again.stdout + again.stderr); assert.match(again.stdout, /already present/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return first.out;
}
const pristineIndex = path.join(ROOT, "tmp/app.asar.contents/.vite/build/index.js");
await test("web patch: injects after the prologue, node --check, idempotent; fails closed on a stale or duplicated injection", async () => {
  const out = checkWeb('"use strict";require("electron");upstream();');
  assert.ok(out.startsWith('"use strict";/*\n * auto_archive_grace_web_main.js'));
  assert.ok(out.endsWith('require("electron");upstream();'));
  const head = runWeb("upstream();"); assert.equal(head.run.status, 0); assert.ok(head.out.startsWith("/*\n * auto_archive_grace_web_main.js") && head.out.endsWith("})();\nupstream();"));
  for (const broken of [out.replace("POLL_MS = 30000", "POLL_MS = 1"), out + out.slice(13)]) {
    const r = runWeb(broken); assert.notEqual(r.run.status, 0); assert.match(r.run.stdout + r.run.stderr, /\[FAIL\]/);
  }
  if (fs.existsSync(pristineIndex) && !fs.readFileSync(pristineIndex, "utf8").includes("__CDB_")) checkWeb(fs.readFileSync(pristineIndex, "utf8"));
  else console.log("SKIP web patch on the pristine index.js: tmp/app.asar.contents missing or already patched");
});
const webMainSource = () => {
  const out = runWeb('"use strict";').out;
  return out.slice('"use strict";'.length);
};
await test("web main: runs the page script on dom-ready in claude.ai pages only, linux only; refresh re-runs it", async () => {
  const code = webMainSource();
  for (const platform of ["linux", "win32"]) {
    let created = null; const all = [];
    const wc = url => { const c = { url, ran: [], handlers: {}, isDestroyed: () => false, getURL() { return c.url; },
      on(ev, fn) { c.handlers[ev] = fn; }, executeJavaScript(src) { c.ran.push(src); return Promise.resolve(); } }; all.push(c); return c; };
    const electron = { app: { on: (ev, fn) => { if (ev === "web-contents-created") created = fn; } }, webContents: { getAllWebContents: () => all } };
    const g = { process: { platform }, require: id => id === "electron" ? electron : require2(id) };
    g.globalThis = g; vm.runInNewContext(code, g);
    if (platform === "win32") { assert.equal(created, null); assert.equal(g.__cdbArchiveGraceWebRefresh, undefined); continue; }
    const pages = ["https://claude.ai/epitaxy/x", "https://preview.claude.ai/", "app://localhost/epitaxy", "https://claude.ai.evil.example/", "http://claude.ai/"].map(wc);
    for (const p of pages) { created({}, p); p.handlers["dom-ready"](); }
    assert.deepEqual(pages.map(p => p.ran.length), [1, 1, 0, 0, 0]);
    assert.ok(pages[0].ran[0].includes("__cdbArchiveGraceWeb") && pages[0].ran[0].includes("[archive-grace-ui]"));
    g.__cdbArchiveGraceWebRefresh(); assert.deepEqual(pages.map(p => p.ran.length), [2, 2, 0, 0, 0]);
  }
});

// A small DOM: elements, text, attribute selectors, React fiber expandos, a
// counted MutationObserver. The fixtures reproduce the markup and props of
// upstream's notice (both shapes) and session rail from the 4.23118.0 ion
// chunks, which are the same React app claude.ai serves.
class Node0 { constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; } 
  get firstChild() { return this.childNodes[0] || null; } get lastChild() { return this.childNodes.at(-1) || null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] || null : null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v) { this.ownerDocument.mutations++; this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = v === "" ? [] : [this.ownerDocument.createTextNode(String(v))]; this.childNodes.forEach(c => { c.parentNode = this; }); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  remove() { if (!this.parentNode) return; this.ownerDocument.mutations++; const s = this.parentNode.childNodes; s.splice(s.indexOf(this), 1); this.parentNode = null; }
  insertBefore(node, ref) { node.remove(); this.ownerDocument.mutations++; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node); node.parentNode = this; return node; }
  appendChild(node) { return this.insertBefore(node, null); } }
class El extends Node0 { constructor(doc, tag) { super(doc); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.listeners = {}; this.disabled = false; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.ownerDocument.mutations++; this.attrs.set(n, String(v)); }
  get className() { return this.getAttribute("class") || ""; } set className(v) { this.setAttribute("class", v); }
  set type(v) { this.attrs.set("type", v); } set title(v) { this.attrs.set("title", v); } get title() { return this.getAttribute("title"); }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  click() { (this.listeners.click || []).forEach(fn => fn({})); }
  matches(sel) { return sel.split(",").some(alt => { const m = /^([a-z]*)((?:\[[^\]]+\])*)$/.exec(alt.trim());
    if (!m || (m[1] && m[1].toUpperCase() !== this.tagName)) return false;
    return [...m[2].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, n, v]) => this.attrs.has(n) && (v === undefined || this.attrs.get(n) === v)); }); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; } }
function makeDom() {
  const doc = new Node0(null); doc.ownerDocument = doc; doc.mutations = 0;
  doc.createElement = tag => new El(doc, tag);
  doc.createTextNode = data => Object.assign(new Node0(doc), { nodeType: 3, data });
  doc.querySelectorAll = sel => { const out = []; const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(doc); return out; };
  doc.body = doc.createElement("body"); doc.documentElement = doc.body; doc.appendChild(doc.body);
  return doc;
}
let fiberSeq = 0;
function el(doc, tag, attrs = {}, children = []) {
  const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.attrs.set(k, v);
  for (const c of children) e.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); return e;
}
function fiber(props, stateNode = null, parent = null) {
  const f = { memoizedProps: props, stateNode, return: parent, child: null };
  if (parent && !parent.child) parent.child = f;
  if (stateNode) stateNode["__reactFiber$t" + fiberSeq] = f;
  return f;
}
const HOLD_TEXT = "This session will be archived automatically after you leave it.";
// Fxt's plain shape: {hold, sessionRef} -> div[role=status].
function plainNotice(doc, parent, sessionRef, hold = { reason: "on_screen" }) {
  const app = fiber({ children: [] });
  const owner = fiber({ hold, sessionRef }, null, app);
  const div = el(doc, "div", { role: "status", "aria-live": "polite", "data-find-omitted": "", class: "max-w-full text-footnote min-w-0 text-secondary" }, [HOLD_TEXT]);
  fiber({ role: "status", children: HOLD_TEXT }, div, owner);
  parent.appendChild(div); return { owner, div };
}
// Fxt's OnScreen shape: {hold, sessionRef} -> Ixt {sessionRef} -> div > span[role=status].
function wrappedNotice(doc, parent, sessionRef) {
  const owner = fiber({ hold: { reason: "on_screen" }, sessionRef });
  const inner = fiber({ sessionRef }, null, owner);
  const span = el(doc, "span", { id: ":r1:", role: "status", "aria-live": "polite", "aria-atomic": "true", class: "min-w-0 text-secondary" }, [HOLD_TEXT]);
  const div = el(doc, "div", { "data-find-omitted": "", class: "flex min-w-0 max-w-full flex-wrap items-baseline gap-x-1.5 text-footnote" }, [span]);
  const divFiber = fiber({ children: [] }, div, inner); fiber({ role: "status" }, span, divFiber);
  parent.appendChild(div); return { owner, div, span };
}
// Rail cards: upstream's card component {id, title, ...} renders a collapsible
// root whose render prop is section[aria-labelledby] (header + panel inside).
function card(doc, id, title, parentFiber) {
  const cardFiber = fiber({ id, title, summary: undefined, children: [] }, null, parentFiber);
  const root = fiber({ open: true, render: {} }, null, cardFiber);
  const section = el(doc, "section", { "aria-labelledby": ":" + id + ":", class: "group/railcard flex shrink-0 flex-col py-md" },
    [el(doc, "div", { class: "group/railtop relative flex" }, [el(doc, "span", { class: "shrink-0" }, [title])]), el(doc, "div", { class: "flex flex-col" })]);
  fiber({ "aria-labelledby": ":" + id + ":" }, section, root);
  return section;
}
function rail(doc, parent, outputsSession, { changes = false } = {}) {
  const owner = fiber({ session: {}, pullRequests: changes ? {} : null, plan: [], artifacts: [], outputsSession });
  const scroll = el(doc, "div", { class: "scroll-fade-y min-h-0 flex-1 overflow-y-auto" });
  const aside = el(doc, "aside", { "aria-label": "Session details", tabindex: "-1", class: "relative flex min-h-0 flex-col font-sans outline-none" },
    [el(doc, "div", { class: "contents" }), scroll]);
  const asideFiber = fiber({ "aria-label": "Session details" }, aside, owner);
  const sections = { environment: card(doc, "environment", "Environment", asideFiber) };
  if (changes) sections.pullRequests = card(doc, "pullRequests", "Changes", asideFiber);
  sections.progress = card(doc, "progress", "Progress", asideFiber);
  for (const sec of Object.values(sections)) scroll.appendChild(sec);
  parent.appendChild(aside); return { owner, aside, scroll, sections };
}
const webPageSource = fs.readFileSync(path.join(ROOT, "js/auto_archive_grace_web_page.js"), "utf8");
function webHost({ minutes = 15, status, pathname = "/epitaxy/local_s", debugFlag = false, noKeep = false } = {}) {
  const doc = makeDom();
  const host = { doc, reads: [], keeps: [], warns: [], observers: [], intervals: new Map(), timeouts: new Map(), nextId: 1, now: 1000000, minutes, status };
  const ctx = {
    document: doc, location: { pathname }, console: { warn: m => host.warns.push(m) },
    Date: { now: () => host.now },
    MutationObserver: class { constructor(cb) { this.cb = cb; this.on = false; host.observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } },
    setInterval: (fn, ms) => { const id = host.nextId++; host.intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => { host.intervals.delete(id); },
    setTimeout: (fn, ms) => { const id = host.nextId++; host.timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: id => { host.timeouts.delete(id); },
    localStorage: { getItem: k => (debugFlag && k === "cdbArchiveGraceDebug" ? "1" : null) },
    cdbExtra: {
      autoArchiveGraceRead: async id => { host.reads.push(id); return id === undefined ? { ok: true, minutes: host.minutes } : (typeof host.status === "function" ? host.status(id) : host.status); }
    }
  };
  if (!noKeep) ctx.cdbExtra.autoArchiveGraceKeep = async id => { host.keeps.push(id); return { ok: true }; };
  vm.createContext(ctx); ctx.window = ctx; host.ctx = ctx;
  host.run = () => vm.runInContext(webPageSource, ctx);
  host.flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  host.mutate = async () => { host.observers.filter(o => o.on).forEach(o => o.cb([])); await host.flush(); };
  host.poll = async () => { for (const { fn } of [...host.intervals.values()]) fn(); await host.flush(); };
  host.lines = () => doc.querySelectorAll("[data-cdb-archive-grace-line]");
  host.keepButtons = () => doc.querySelectorAll("[data-cdb-archive-grace-keep]").map(b => b.firstChild);
  return host;
}
const TERMINAL = { ok: true, active: true, enabled: true, terminal: true };
await test("web page: delay Immediately -> one settings read, no observer, no timer, no DOM change", async () => {
  for (const minutes of [0, null]) {
    const h = webHost({ minutes, status: { ...TERMINAL, deadline: 2000000 } });
    const main = h.doc.body.appendChild(el(h.doc, "main")); plainNotice(h.doc, main, { type: "local", id: "local_s" }); rail(h.doc, main, { type: "local", id: "local_s" });
    const before = h.doc.mutations; h.run(); await h.flush();
    assert.deepEqual(h.reads, [undefined], "one read of the setting, no session read");
    assert.equal(h.observers.length, 0); assert.equal(h.intervals.size, 0);
    assert.equal(h.doc.mutations, before); assert.equal(h.warns.length, 0);
    assert.equal(h.ctx.__cdbArchiveGraceDebug, undefined, "no debug hook without the localStorage flag");
  }
  const noBridge = webHost(); delete noBridge.ctx.cdbExtra; noBridge.run(); await noBridge.flush();
  assert.equal(noBridge.observers.length, 0); assert.equal(noBridge.warns.length, 1); assert.match(noBridge.warns[0], /^\[archive-grace-ui\] no-bridge: /);
});
await test("web page: terminal PR -> one line after upstream's notice (both shapes), upstream untouched, outside the live region; polls 30 s", async () => {
  let answer = { ...TERMINAL, deadline: 1000000 + 12 * 60000 - 5000 };
  const h = webHost({ status: () => answer });
  const main = h.doc.body.appendChild(el(h.doc, "main"));
  const a = plainNotice(h.doc, main, { type: "local", id: "local_s" });
  h.run(); await h.flush();
  assert.equal(h.observers.length, 1); assert.equal(h.observers[0].on, true);
  assert.deepEqual(h.reads, [undefined, "local_s"]);
  const [line] = h.lines();
  assert.equal(a.div.nextSibling, line, "a sibling right after the notice");
  assert.equal(a.div.textContent, HOLD_TEXT, "upstream's text unchanged"); assert.equal(a.div.childNodes.length, 1);
  assert.equal(line.getAttribute("aria-live"), "off"); assert.equal(line.getAttribute("role"), null);
  assert.equal(line.closest('[role="status"]'), null, "not inside a live region");
  assert.equal(line.className, "max-w-full text-footnote min-w-0 text-secondary");
  assert.match(line.textContent, /about 12 min left/);
  assert.equal(h.intervals.size, 1); assert.equal([...h.intervals.values()][0].ms, 30000);
  answer = { ...answer, deadline: 1000000 + 125 * 60000 }; await h.poll(); assert.match(line.textContent, /about 2 h 5 min left/);
  h.now = answer.deadline; await h.poll(); assert.match(line.textContent, /delay has ended/);
  answer = { ...answer, deadline: null }; await h.poll(); assert.match(line.textContent, /starts at the next archive sweep/);
  const quiet = h.doc.mutations; await h.mutate(); assert.equal(h.doc.mutations, quiet, "a rescan with nothing new writes nothing");
  // The OnScreen shape: span[role=status] inside upstream's wrapper.
  const b = wrappedNotice(h.doc, main, { type: "local", id: "local_t" }); await h.mutate();
  const second = h.lines().find(l => l.getAttribute("data-session") === "local_t");
  assert.equal(b.div.nextSibling, second); assert.equal(b.span.textContent, HOLD_TEXT);
  assert.equal(second.className, "max-w-full text-footnote min-w-0 text-secondary");
  // Not terminal / rule off / delay off: no line; off stops the poll.
  answer = { ...TERMINAL, terminal: false }; await h.poll(); assert.equal(h.lines().length, 0); assert.equal(h.intervals.size, 2);
  answer = { ok: true, active: false }; await h.poll(); assert.equal(h.intervals.size, 0, "poll stops once the delay is Immediately");
  // Unmount: the notice leaves, the session state goes with it.
  answer = { ...TERMINAL, deadline: 2000000 }; a.div.remove(); b.div.remove(); await h.mutate();
  assert.equal(h.ctx.__cdbArchiveGraceWeb.state().sessions.length, 0);
  // A cloud session or another route: upstream's notice only, no read.
  const reads = h.reads.length; plainNotice(h.doc, main, { type: "remote", id: "r" }); await h.mutate();
  assert.equal(h.reads.length, reads); assert.equal(h.lines().length, 0);
  h.ctx.location.pathname = "/new"; plainNotice(h.doc, main, { type: "local", id: "local_u" }); await h.mutate();
  assert.equal(h.reads.length, reads, "outside the Code route nothing is read");
  // Switch to Immediately: main re-runs the page script -> one read, observer gone, nodes removed.
  h.ctx.location.pathname = "/epitaxy/local_u"; await h.mutate(); assert.equal(h.lines().length, 1);
  h.minutes = 0; h.run(); await h.flush();
  assert.equal(h.observers[0].on, false); assert.equal(h.lines().length, 0); assert.equal(h.intervals.size, 0);
  assert.equal(h.observers.length, 1, "the re-run reuses the installed module");
});
await test("web page: keep button only when terminal, at the end of the rail; one keep(id) and it stays hidden", async () => {
  const h = webHost({ status: { ...TERMINAL, deadline: 2000000 } });
  const main = h.doc.body.appendChild(el(h.doc, "main"));
  const r = rail(h.doc, main, { type: "local", id: "local_s" });
  h.run(); await h.flush();
  const [button] = h.keepButtons();
  assert.equal(r.aside.lastChild, button.parentNode, "no Changes card: appended after upstream's two children");
  assert.equal(r.aside.childNodes.length, 3); assert.equal(button.textContent, "Keep this session");
  assert.deepEqual(h.warns.map(w => w.split(":")[0]), ["[archive-grace-ui] rail-changes"], "one fallback line");
  assert.equal(button.closest('[role="status"]'), null);
  button.click(); button.click(); await h.flush();
  assert.deepEqual(h.keeps, ["local_s"], "one keep for this session");
  assert.equal(h.keepButtons().length, 0, "hidden after keep");
  await h.poll(); await h.mutate(); assert.equal(h.keepButtons().length, 0, "a stale read cannot bring it back");
  // With the Changes card: right below it, before the next card; once per session.
  const c = webHost({ status: { ...TERMINAL, deadline: 2000000 } });
  const cr = rail(c.doc, c.doc.body, { type: "local", id: "local_s" }, { changes: true });
  c.run(); await c.flush(); await c.mutate();
  const [cb] = c.keepButtons();
  assert.equal(cr.sections.pullRequests.nextSibling, cb.parentNode, "directly after the Changes card");
  assert.equal(cb.parentNode.nextSibling, cr.sections.progress); assert.equal(cr.aside.childNodes.length, 2, "nothing at the aside's end");
  assert.equal(cr.sections.pullRequests.querySelectorAll("[data-cdb-archive-grace-keep]").length, 0, "upstream's card untouched");
  assert.equal(c.keepButtons().length, 1); assert.equal(c.warns.length, 0);
  const quiet = c.doc.mutations; await c.mutate(); assert.equal(c.doc.mutations, quiet);
  cb.click(); await c.flush(); assert.deepEqual(c.keeps, ["local_s"]); assert.equal(c.keepButtons().length, 0);
  // Failure shows an alert and keeps the button.
  const f = webHost({ status: { ...TERMINAL, deadline: 2000000 } });
  rail(f.doc, f.doc.body, { type: "local", id: "local_s" }); f.ctx.cdbExtra.autoArchiveGraceKeep = async () => ({ ok: false, error: "x" });
  f.run(); await f.flush(); f.keepButtons()[0].click(); await f.flush();
  assert.equal(f.doc.querySelectorAll('[role="alert"]')[0].textContent, "Could not keep this session. Try again.");
  assert.equal(f.keepButtons().length, 1);
  // Not terminal, or no keep channel: no button.
  for (const [status, noKeep] of [[{ ...TERMINAL, terminal: false }, false], [{ ...TERMINAL, deadline: 1 }, true]]) {
    const n = webHost({ status, noKeep }); rail(n.doc, n.doc.body, { type: "local", id: "local_s" });
    n.run(); await n.flush(); assert.equal(n.keepButtons().length, 0);
  }
});
await test("web page: a terminal read without a start time is retried once after 3 s, then only the 30 s poll", async () => {
  let answer = { ...TERMINAL, deadline: null };
  const h = webHost({ status: () => answer });
  plainNotice(h.doc, h.doc.body, { type: "local", id: "local_s" });
  h.run(); await h.flush();
  assert.match(h.lines()[0].textContent, /starts at the next archive sweep/);
  assert.equal(h.timeouts.size, 1); assert.equal([...h.timeouts.values()][0].ms, 3000);
  answer = { ...TERMINAL, deadline: 1000000 + 30 * 60000 };
  const reads = h.reads.length; const [[tid, timer]] = [...h.timeouts]; h.timeouts.delete(tid); timer.fn(); await h.flush();
  assert.equal(h.reads.length, reads + 1); assert.match(h.lines()[0].textContent, /about 30 min left/);
  answer = { ...TERMINAL, deadline: null }; await h.poll(); await h.mutate();
  assert.equal(h.timeouts.size, 0, "one retry per session, polls never retry");
  // A deadline on the first read, or an unmount before the retry: no retry left behind.
  const d = webHost({ status: { ...TERMINAL, deadline: 2000000 } }); plainNotice(d.doc, d.doc.body, { type: "local", id: "local_s" });
  d.run(); await d.flush(); assert.equal(d.timeouts.size, 0);
  const u = webHost({ status: { ...TERMINAL, deadline: null } }); const n = plainNotice(u.doc, u.doc.body, { type: "local", id: "local_s" });
  u.run(); await u.flush(); assert.equal(u.timeouts.size, 1); n.div.remove(); await u.mutate(); assert.equal(u.timeouts.size, 0);
});
await test("web page: a moved anchor logs one [archive-grace-ui] line and leaves upstream's DOM alone", async () => {
  const h = webHost({ status: { ...TERMINAL, deadline: 2000000 } });
  const main = h.doc.body.appendChild(el(h.doc, "main"));
  // Notice without {hold, sessionRef} props (renamed upstream).
  const owner = fiber({ reason: {}, ref: { type: "local", id: "local_s" } });
  const div = el(h.doc, "div", { role: "status", "aria-live": "polite", class: "x" }, [HOLD_TEXT]); fiber({}, div, owner); main.appendChild(div);
  // Rail without outputsSession.
  const railOwner = fiber({ session: {}, pullRequests: null, sessionRef: { type: "local", id: "local_s" } });
  const aside = el(h.doc, "aside", { "aria-label": "Session details" }, [el(h.doc, "div")]); fiber({}, aside, railOwner); main.appendChild(aside);
  // A notice element with no fiber at all.
  main.appendChild(el(h.doc, "div", { role: "status", "aria-live": "polite" }, ["Claude is waiting for your reply, so automatic archiving is paused for up to a day."]));
  const before = h.doc.mutations;
  h.run(); await h.flush(); await h.mutate(); await h.mutate();
  assert.equal(h.doc.mutations, before, "no DOM change");
  assert.deepEqual(h.reads, [undefined], "no session read");
  assert.deepEqual(h.warns.map(w => w.split(":")[0]).sort(), ["[archive-grace-ui] no-fiber", "[archive-grace-ui] notice-props", "[archive-grace-ui] rail-props"], "one line per key");
  // An unrelated status (no archive wording) is not a warning.
  const quiet = webHost(); quiet.doc.body.appendChild(el(quiet.doc, "div", { role: "status", "aria-live": "polite" }, ["Saved"]));
  quiet.run(); await quiet.flush(); assert.equal(quiet.warns.length, 0);
});
await test("web page: debug hook exists only with the localStorage flag and renders a fake terminal status without IPC writes", async () => {
  const h = webHost({ minutes: 0, debugFlag: true, status: { ok: true, active: false } });
  const main = h.doc.body.appendChild(el(h.doc, "main"));
  plainNotice(h.doc, main, { type: "local", id: "local_s" }); rail(h.doc, main, { type: "local", id: "local_s" });
  h.run(); await h.flush(); assert.equal(h.observers.length, 0);
  const state = await h.ctx.__cdbArchiveGraceDebug({ deadline: 1000000 + 10 * 60000 }); await h.flush();
  assert.equal(state.debug, true); assert.match(h.lines()[0].textContent, /about 10 min left/);
  h.keepButtons()[0].click(); await h.flush();
  assert.deepEqual(h.keeps, [], "debug keep is not sent"); assert.match(h.warns.at(-1), /debug-keep/);
  await h.ctx.__cdbArchiveGraceDebug(null); await h.flush();
  assert.equal(h.lines().length, 0); assert.equal(h.observers[0].on, false, "back to the real (off) setting");
});
await test("keep channel: validated in main, calls upstream's session setter with (id, false) once; bridge forwards the id", async () => {
  const extra = path.join(ROOT, "patches/core/add_feature_extra_settings");
  const Module = require2("module");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-grace-keep-")), file = path.join(dir, "extra.cjs");
  try {
    fs.writeFileSync(file, 'function FHa(e=[]){let t=G().type==="3p"&&ou()==="1p"?[...e,j$t]:e;a.app.isPackaged?Mj(!0,t):fj(t)}\n' + 'var Hrr,Urr;function Yrr(){return Urr??=(async()=>{let t,n,r,s;return Hrr={qemuPath:t,firmwarePath:n,virtiofsdPath:r,virtiofsdAptInstallable:!0,kvm:s},Hrr})(),Urr}function Xrr(){return Hrr}\n' + 'function nav0(){let Uy=go(Hy,"Navigation",Xy,{events:[["navigate",[["path",I]]]]});return Uy}\n');
    execFileSync(extra, [file]); const handlers = {}, userData = path.join(dir, "Claude"); fs.mkdirSync(userData);
    const electron = { app: { getPath: () => userData, on() {}, once() {} },
      ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, removeHandler() {} }, shell: {} };
    const original = Module._load, descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Module._load = function (id, ...args) { return id === "electron" ? electron : original.call(this, id, ...args); };
    Object.defineProperty(process, "platform", { value: "linux" });
    try { require2(file); } finally { Module._load = original; Object.defineProperty(process, "platform", descriptor); }
    const event = url => ({ sender: { isDestroyed: () => false, getURL: () => url }, senderFrame: { parent: null } });
    const keep = (id, url = "https://claude.ai/epitaxy/x") => handlers["cdb-archive-grace:keep"](event(url), id);
    // The engine-side hook from js/auto_archive_grace.js, against a fake session manager.
    const h = harness(); const sets = [];
    h.engine.sessionManager.setSessionAutoArchiveOnPrClose = (...args) => sets.push(args);
    h.restart();
    let refreshed = 0; globalThis.__cdbArchiveGraceWebRefresh = () => { refreshed++; };
    assert.equal((await keep("s")).ok, false, "delay off");
    assert.equal((await handlers["cdb-archive-grace:set"](event("https://claude.ai/"), 15)).ok, true); assert.equal(refreshed, 1, "a delay change re-runs the page script");
    assert.match((await keep("s")).error, /not swept/);
    globalThis.__cdbArchiveGraceKeep = h.g.__cdbArchiveGraceKeep;
    for (const bad of [undefined, "", 5, "x".repeat(257)]) assert.equal((await keep(bad)).ok, false);
    assert.equal((await keep("s", "https://claude.ai.evil.example/")).ok, false, "origin-checked");
    assert.deepEqual(sets, []);
    assert.deepEqual(await keep("s"), { ok: true }); assert.deepEqual(sets, [["s", false]]);
    assert.ok(h.logs.some(l => /s: kept/.test(l)));
    h.session.isArchived = true; assert.equal((await keep("s")).ok, false); assert.equal(sets.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ["__cdbAutoArchiveMergeDelayMinutes", "__cdbArchiveGraceKeep", "__cdbArchiveGraceWebRefresh"]) delete globalThis[k];
  }
  const calls = []; let api;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/extra_settings_bridge.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); } } }) });
  api.autoArchiveGraceKeep("s"); assert.deepEqual(calls, [["cdb-archive-grace:keep", "s"]]);
});
console.log(`${passed} archive-grace tests passed`);
