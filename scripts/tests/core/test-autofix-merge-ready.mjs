#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const source = readFileSync(new URL("../../../js/autofix_merge_ready.js", import.meta.url), "utf8");
const factory = vm.runInNewContext(source, { process: { pid: 123 }, globalThis: {} });
const head = "a".repeat(40), base = "b".repeat(40);
const pr = { repo: "Owner/Repo", prNumber: 1 };
const session = { sessionId: "session" };
const good = () => ({ state: "OPEN", isDraft: false, headRefOid: head, baseRefOid: base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, isMergeQueueEnabled: false, commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] } });
function harness(disk = new Map(), parked = new Set()) {
  let value = good(), queue = [], delivery = { delivered: true }, calls = 0, count = 0, failWrite = false, hook;
  const sent = [];
  const record = { ...session, prs: [{ ...pr, state: "OPEN", autoFix: true }] };
  const engine = { diffState: new Map([[session.sessionId, new Map([["owner/repo#1", {}]])]]), sessionManager: {
    githubPr: { config: { getSession: () => record }, ghRest: { async graphqlWithErrors() {
      calls++;
      const item = queue.length ? queue.shift() : value;
      if (item instanceof Error) throw item;
      if (item?.errors) return item;
      return { data: { repository: { pullRequest: item } }, errors: [] };
    } } },
    cliGovernor: { isAtCap: () => false }, hasLiveQuery: () => false,
    isSendParked: (_s, id) => parked.has(id),
    async withdrawParkedSend(_s, id) { parked.delete(id); return true; },
    async sendMessage(...args) {
      sent.push(args);
      if (hook) hook(args[3].messageUuid);
      if (delivery instanceof Error) throw delivery;
      if (delivery.queued) parked.add(args[3].messageUuid);
      return delivery;
    }
  } };
  const fs = {
    readFileSync(file) { if (!disk.has(file)) throw Object.assign(Error("missing"), { code: "ENOENT" }); return disk.get(file); },
    writeFileSync(file, data, options) { assert.equal(options.mode, 0o600); if (failWrite) throw Error("disk full"); disk.set(file, data); },
    renameSync(from, to) { disk.set(to, disk.get(from)); disk.delete(from); }
  };
  const api = factory(engine, { fs, path: { join: (...parts) => parts.join("/") }, userData: "/profile", uuid: () => `uuid-${++count}` });
  return { api, engine, disk, sent, parked, record, set: v => { value = v; }, queue: (...v) => { queue = v; }, delivery: v => { delivery = v; }, writesFail: () => { failWrite = true; }, hook: v => { hook = v; }, calls: () => calls, check: () => api.check(session, pr) };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
await test("fresh double read, repeat and restart deduplication", async () => {
  const h = harness(); await h.check(); await h.check(); assert.equal(h.sent.length, 1); assert.equal(h.calls(), 4);
  const restarted = harness(h.disk); await restarted.check(); assert.equal(restarted.sent.length, 0);
  const [_id, message, _attachments, options] = h.sent[0];
  assert.match(message, /does not authorize merge, auto-merge, deployment/); assert.equal(options.initiator, "ci-monitor");
});
for (const mergeStateStatus of ["UNKNOWN", "BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "DRAFT", undefined]) {
  await test(`reject merge state ${mergeStateStatus}`, async () => { const h = harness(); h.set({ ...good(), mergeStateStatus }); await h.check(); assert.equal(h.sent.length, 0); });
}
for (const overrides of [{ state: "CLOSED" }, { state: "MERGED" }, { state: undefined }, { isDraft: true }, { isDraft: undefined }, { reviewDecision: "CHANGES_REQUESTED" }, { reviewDecision: "REVIEW_REQUIRED" }, { reviewDecision: undefined }, { mergeable: "UNKNOWN" }, { mergeable: "CONFLICTING" }, { isMergeQueueEnabled: true }, { isMergeQueueEnabled: undefined }, { headRefOid: undefined }, { commits: undefined }]) {
  await test(`reject ${JSON.stringify(overrides)}`, async () => { const h = harness(); h.set({ ...good(), ...overrides }); await h.check(); assert.equal(h.sent.length, 0); });
}
for (const conclusion of ["FAILURE", "CANCELLED", "SKIPPED", "NEUTRAL", "TIMED_OUT", "ACTION_REQUIRED", "STALE", null, undefined]) {
  await test(`reject check ${conclusion}`, async () => { const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = conclusion; h.set(p); await h.check(); assert.equal(h.sent.length, 0); });
}
for (const status of ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING"]) {
  await test(`reject pending ${status}`, async () => { const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].status = status; h.set(p); await h.check(); assert.equal(h.sent.length, 0); });
}
await test("explicit no checks and approved reviews", async () => { const h = harness(), p = good(); p.reviewDecision = "APPROVED"; p.commits.nodes[0].commit.statusCheckRollup = null; h.set(p); await h.check(); assert.equal(h.sent.length, 1); });
for (const mutation of [p => { p.commits.nodes[0].commit.oid = base; }, p => { p.commits.nodes[0].commit.statusCheckRollup = undefined; }, p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true; }, p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = []; }, p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: "Other" }]; }, p => { p.commits.nodes[0].commit.statusCheckRollup.state = "PENDING"; }]) {
  await test("reject incomplete/truncated/mismatched rollup", async () => { const h = harness(), p = good(); mutation(p); h.set(p); await h.check(); assert.equal(h.sent.length, 0); });
}
for (const state of ["PENDING", "ERROR", "FAILURE", undefined]) {
  await test(`reject status context ${state}`, async () => { const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: "StatusContext", state }]; h.set(p); await h.check(); assert.equal(h.sent.length, 0); });
}
await test("status context succeeds", async () => { const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: "StatusContext", state: "SUCCESS" }]; h.set(p); await h.check(); assert.equal(h.sent.length, 1); });
await test("HEAD/base changes across reads do not notify", async () => {
  for (const field of ["headRefOid", "baseRefOid"]) { const h = harness(); h.queue(good(), { ...good(), [field]: "c".repeat(40) }); await h.check(); assert.equal(h.sent.length, 0); }
});
await test("second read pending/failed/partial/unknown fails closed", async () => {
  for (const second of [Error("offline"), { data: { repository: { pullRequest: good() } }, errors: [{ type: "FORBIDDEN" }] }, { ...good(), mergeStateStatus: "BLOCKED" }, { ...good(), mergeStateStatus: "UNKNOWN" }, null]) { const h = harness(); h.queue(good(), second); await h.check(); assert.equal(h.sent.length, 0); }
});
await test("outage never rearms a delivered transition", async () => { const h = harness(); await h.check(); h.set(Error("offline")); await h.check(); h.set({ ...good(), mergeStateStatus: "UNKNOWN" }); await h.check(); h.set(good()); await h.check(); assert.equal(h.sent.length, 1); });
await test("known pending to ready transition rearms, including restart", async () => { const h = harness(); await h.check(); h.set({ ...good(), mergeStateStatus: "BLOCKED" }); await h.check(); const restarted = harness(h.disk); await restarted.check(); assert.equal(restarted.sent.length, 1); });
await test("new HEAD is a new notification", async () => { const h = harness(); await h.check(); const p = good(); p.headRefOid = p.commits.nodes[0].commit.oid = "c".repeat(40); h.set(p); await h.check(); assert.equal(h.sent.length, 2); });
for (const delivery of [{ delivered: false }, Error("send failed")]) {
  await test("failed delivery remains retriable after restart", async () => { const h = harness(); h.delivery(delivery); await h.check(); const restarted = harness(h.disk); await restarted.check(); assert.equal(restarted.sent.length, 1); });
}
await test("queued acceptance, completion and dropped delivery", async () => {
  const h = harness(); h.delivery({ delivered: true, queued: true }); await h.check(); await h.check(); assert.equal(h.sent.length, 1);
  const id = h.sent[0][3].messageUuid; h.api.completed(session.sessionId, id);
  const restarted = harness(h.disk); await restarted.check(); assert.equal(restarted.sent.length, 0);
  h.api.dropped(session.sessionId, [id]); await h.check(); assert.equal(h.sent.length, 2);
});
await test("surviving parked queue is not duplicated on restart", async () => { const h = harness(); h.delivery({ delivered: true, queued: true }); await h.check(); const restarted = harness(h.disk, h.parked); await restarted.check(); assert.equal(restarted.sent.length, 0); restarted.api.completed(session.sessionId, h.sent[0][3].messageUuid); const again = harness(h.disk); await again.check(); assert.equal(again.sent.length, 0); });
await test("unconfirmed queue retries after restart", async () => { const h = harness(); h.delivery({ delivered: true, queued: true }); await h.check(); const restarted = harness(h.disk); await restarted.check(); assert.equal(restarted.sent.length, 1); });
await test("completion/drop while sendMessage resolves", async () => {
  for (const dropped of [false, true]) { const h = harness(); h.delivery({ delivered: true, queued: true }); h.hook(id => dropped ? h.api.dropped(session.sessionId, [id]) : h.api.completed(session.sessionId, id)); await h.check(); h.hook(undefined); await h.check(); assert.equal(h.sent.length, dropped ? 2 : 1); }
});
await test("completion is banked but not persisted before acceptance", async () => {
  const h = harness(); h.delivery({ delivered: false });
  h.hook(id => { h.api.completed(session.sessionId, id); const ledger = JSON.parse(h.disk.get("/profile/autofix-merge-ready.json")); assert.equal(ledger.states["github.com/owner/repo#1"].notified, false); });
  await h.check(); const restarted = harness(h.disk); await restarted.check(); assert.equal(restarted.sent.length, 1);
});
await test("queued stale readiness is withdrawn", async () => { const h = harness(); h.delivery({ delivered: true, queued: true }); await h.check(); h.set({ ...good(), mergeStateStatus: "BLOCKED" }); await h.check(); assert.equal(h.parked.size, 0); });
await test("cap and disk failure do not send", async () => { const h = harness(); h.engine.sessionManager.cliGovernor.isAtCap = () => true; await h.check(); assert.equal(h.sent.length, 0); h.engine.sessionManager.cliGovernor.isAtCap = () => false; h.writesFail(); await h.check(); assert.equal(h.sent.length, 0); });
await test("corrupt persistence fails closed", async () => { const h = harness(new Map([["/profile/autofix-merge-ready.json", "invalid json"]])); await h.check(); assert.equal(h.sent.length, 0); });
await test("PR detached during a read cannot wake", async () => { const h = harness(); h.engine.sessionManager.githubPr.ghRest.graphqlWithErrors = async () => { h.engine.diffState.clear(); return { data: { repository: { pullRequest: good() } }, errors: [] }; }; await h.check(); assert.equal(h.sent.length, 0); });
await test("concurrent checks deduplicate", async () => { const h = harness(); await Promise.all([h.check(), h.check()]); assert.equal(h.sent.length, 1); });
await test("host and repository are separate identities", async () => { const h = harness(); await h.check(); const enterprise = { ...pr, host: "git.example.org" }; h.record.prs.push({ ...enterprise, state: "OPEN", autoFix: true }); h.engine.diffState.get(session.sessionId).set("git.example.org\nowner/repo#1", {}); await h.api.check(session, enterprise); const other = { ...pr, repo: "Owner/Other" }; h.record.prs.push({ ...other, state: "OPEN", autoFix: true }); h.engine.diffState.get(session.sessionId).set("owner/other#1", {}); await h.api.check(session, other); assert.equal(h.sent.length, 3); });
for (const mutation of [h => { h.record.isArchived = true; }, h => { h.record.prs[0].autoFix = false; }, h => { h.record.prs[0].dismissed = true; }, h => { h.record.prs = []; }]) {
  await test("monitor disabled during a read cannot wake", async () => {
    const h = harness();
    h.engine.sessionManager.githubPr.ghRest.graphqlWithErrors = async () => { mutation(h); return { data: { repository: { pullRequest: good() } }, errors: [] }; };
    await h.check(); assert.equal(h.sent.length, 0);
  });
}
await test("new HEAD withdraws a parked older readiness wake", async () => {
  const h = harness(); h.delivery({ delivered: true, queued: true }); await h.check();
  const p = good(); p.headRefOid = p.commits.nodes[0].commit.oid = "c".repeat(40); h.set(p); await h.check();
  assert.equal(h.sent.length, 2); assert.equal(h.parked.size, 1);
});
await test("original engine closure rearms a later reopen at the same HEAD", async () => {
  const h = harness(); await h.check(); const entry = h.engine.diffState.get(session.sessionId).get("owner/repo#1"); entry.closed = true; await h.check(); assert.equal(h.sent.length, 1);
  entry.closed = false; await h.check(); assert.equal(h.sent.length, 2);
});
await test("unknown check fields do not rearm a completed notice", async () => {
  const h = harness(); await h.check(); const p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = undefined;
  h.set(p); await h.check(); h.set(good()); await h.check(); assert.equal(h.sent.length, 1);
});
await test("compiled patch wires the real sweep and delivery method shapes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "merge-ready-patch-"));
  try {
    const target = join(directory, "fixture.js");
    const binary = fileURLToPath(new URL("../../../patches/core/add_autofix_merge_ready", import.meta.url));
    const fixture = 'class Engine {async checkSession($s,p$){this.original=true}handleTurnCompleted($s,m$){try{this.completedOriginal=true}catch{}}handleSendsDroppedUnsent($s,m$,r$){try{this.droppedOriginal=true}catch{}}}';
    writeFileSync(target, fixture);
    let result = spawnSync(binary, [target], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
    const patched = readFileSync(target, "utf8");
    result = spawnSync(binary, [target], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(target, "utf8"), patched);
    const Engine = vm.runInNewContext(patched + ';Engine', { process: { platform: "linux" } });
    const engine = new Engine(); let checks = 0, completed = 0, dropped = 0;
    engine.__cdbMergeReady = { check: async () => { assert.equal(engine.original, true); checks++; }, completed: () => { completed++; }, dropped: () => { dropped++; } };
    await engine.checkSession(session, pr); engine.handleTurnCompleted("session", "id"); engine.handleSendsDroppedUnsent("session", ["id"], "lost");
    assert.equal(checks, 1); assert.equal(completed, 1); assert.equal(dropped, 1); assert.equal(engine.completedOriginal, true); assert.equal(engine.droppedOriginal, true);
    for (const invalid of [fixture.replace('async checkSession', 'async changed'), fixture + fixture, patched.replace('this.__cdbMergeReady.completed(', 'this.broken(')]) {
      writeFileSync(target, invalid); result = spawnSync(binary, [target], { encoding: "utf8" }); assert.notEqual(result.status, 0);
    }
    const OtherEngine = vm.runInNewContext(patched + ';Engine', { process: { platform: "other" } });
    const other = new OtherEngine(); await other.checkSession(session, pr); assert.equal(other.original, true); assert.equal(other.__cdbMergeReady, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
console.log(`${passed} merge-ready tests passed`);
