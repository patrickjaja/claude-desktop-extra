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
await test("open and unknown answers discard prior deadline without delaying", async () => {
  for (const state of ["open", null]) {
    const h = harness(); await h.wait(); assert.equal(await h.wait(state), false); assert.deepEqual(h.state(), {});
  }
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

const binary = path.join(ROOT, "patches/core/add_auto_archive_grace");
fs.accessSync(binary, fs.constants.X_OK);
// Mirrors the stable native method shapes, including the comma-expression
// terminal check. Dollar identifiers deliberately exercise the minifier contract.
const fixture = `const e$={drt:()=>true},n$={s:s=>s==='merged'||s==='closed'},i$={inspectSessionWorktree:async()=>null};
class Engine {
constructor(manager){this.sessionManager=manager;this.calls=[];this.reopenSeen=new Map}
answered(){}
freshReopen(t$,u$){if(this.calls.push('fresh'),u$.length>0)return this.answered(t$.sessionId,"close"),this.reopenSeen.set(t$.sessionId,{})}
async sweep(k$=!1){this.calls.push('sweep')}
ownPrBindings(prs){return(prs||[]).filter(p=>!p.inherited)}
terminalVerdict(id,prs){return{terminal:prs.length>0&&prs.every(p=>p.state==='MERGED'||p.state==='CLOSED'),merged:prs.length>0&&prs.every(p=>p.state==='MERGED')}}
holdReason(){return null}
async checkAndArchive(r$,a$,s$,c$){let l$=s$?'inactive':'pr';let d$=this.state;
if(!s$){if(this.calls.push('lookup'),!n$.s(d$))return;let h$=this.holdReason(r$,l$);}
let v$=await i$.inspectSessionWorktree(null,r$);
if(l$==='pr'&&(this.sessionManager.sessionAutoArchiveOnPrClose(r$.sessionId)??e$.drt("ccAutoArchiveOnPrClose")===!0)===!1)return;
let g$=this.held;let S$=this.holdReason(r$,l$);if(g$&&(!S$||false))return;
this.calls.push('archive');}
}globalThis.Engine=Engine;`;
await test("compiled patch applies, preserves syntax, exact idempotence and fails closed on changed anchors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-grace-patch-")), file = path.join(dir, "fixture.js");
  try {
    fs.writeFileSync(file, fixture); execFileSync(binary, [file]);
    const patched = fs.readFileSync(file, "utf8"); execFileSync(process.execPath, ["--check", file]);
    execFileSync(binary, [file]); assert.equal(fs.readFileSync(file, "utf8"), patched);
    for (const text of [fixture + fixture, fixture.replace("checkAndArchive", "changed"),
      fixture.replace("async sweep", "async changed"), patched.replace(".reconcileAll()", ".wrong()"),
      patched.replace("await this.__cdbGrace().wait", "await this.wrong().wait"),
      patched.replace("this.__cdbGrace().cancel(", "this.__cdbGrace().broken(")]) {
      fs.writeFileSync(file, text); assert.notEqual(spawnSync(binary, [file]).status, 0);
    }
    // Run the actual injected methods, not just the helper.
    const h = harness(); let clock = 1000000;
    const context = { Date: { now: () => clock }, require: id => id === "node:fs" ? { readFileSync() { throw Object.assign(Error(), { code: "ENOENT" }); },
      mkdirSync() {}, writeFileSync() {}, renameSync() {} } : id === "node:path" ? path : { app: { getPath: () => "/profile" } },
      process: { platform: "linux" }, globalThis: { __cdbAutoArchiveMergeDelayMinutes: () => 15 } };
    vm.runInNewContext(patched, context);
    const manager = { ...h.engine.sessionManager, sessionAutoArchiveOnPrClose: () => true };
    const engine = new context.globalThis.Engine(manager); engine.state = "merged";
    await engine.checkAndArchive(h.session, Date.now(), false, false); assert.equal(engine.calls.includes("archive"), false);
    clock += 14 * 60000; engine.freshReopen(h.session, [{}]);
    engine.state = "closed"; await engine.checkAndArchive(h.session, Date.now(), false, false);
    clock += 2 * 60000; await engine.checkAndArchive(h.session, Date.now(), false, false);
    assert.equal(engine.calls.includes("archive"), false, "confirmed native reopen cancels the old clock and CLOSED gets a new grace");
    engine.calls.length = 0; engine.state = "merged"; await engine.checkAndArchive(h.session, Date.now(), true, false);
    assert.equal(engine.calls.includes("archive"), true, "inactivity is unchanged");
    await engine.sweep(); assert.equal(engine.calls.includes("sweep"), true);
    context.process.platform = "win32"; engine.calls.length = 0;
    await engine.checkAndArchive(h.session, Date.now(), false, false); assert.equal(engine.calls.includes("archive"), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
      fs.writeFileSync(jsonc, '{"autoArchiveMergeDelayMinutes": "bad"}');
      assert.equal((await call("read")).lockedByJsonc, true); assert.equal(globalThis.__cdbAutoArchiveMergeDelayMinutes(), 0);
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
