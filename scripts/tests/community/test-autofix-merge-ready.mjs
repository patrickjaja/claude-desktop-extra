#!/usr/bin/env node
// test-autofix-merge-ready.mjs - the "Wake Auto-fix sessions when a PR is ready
// to merge" community feature: the helper js/autofix_merge_ready.js (verdicts,
// delivery ledger, cost rules), the compiled wrapper
// patches/community/add_feature_autofix_merge_ready (switch gate, containment,
// idempotency), and the settings half (autoFixMergeReady key, its channels,
// bridge methods and page row).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(join(ROOT, "js/autofix_merge_ready.js"), "utf8");
const factory = vm.runInNewContext(source, { process: { pid: 123 }, globalThis: {} });
const head = "a".repeat(40), base = "b".repeat(40), other = "c".repeat(40);
const pr = { repo: "Owner/Repo", prNumber: 1 };
const session = { sessionId: "session" };
const LEDGER = "/profile/autofix-merge-ready.json";
const good = () => ({ state: "OPEN", isDraft: false, headRefOid: head, baseRefOid: base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, isMergeQueueEnabled: false, commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] } });
const atHead = (oid, p = good()) => { p.headRefOid = p.commits.nodes[0].commit.oid = oid; return p; };
function harness(disk = new Map(), parked = new Set()) {
  let value = good(), queue = [], delivery = { delivered: true }, calls = 0, count = 0, failWrite = false, hook, clock = 1_000_000, writes = 0;
  const sent = [];
  const budget = { graphql: { remaining: 4000, rateLimited: false } };
  const record = { ...session, prs: [{ ...pr, state: "OPEN", autoFix: true }] };
  const githubPr = {
    config: { getSession: () => record },
    readBudgets: () => budget,
    graphqlBudgetLow: (_host, remaining) => remaining !== undefined && remaining < 300,
    ghRest: { async graphqlWithErrors() {
      calls++;
      const item = queue.length ? queue.shift() : value;
      if (item instanceof Error) throw item;
      if (item?.errors) return item;
      return { data: { repository: { pullRequest: item } }, errors: [] };
    } }
  };
  const engine = { diffState: new Map([[session.sessionId, new Map([["owner/repo#1", {}]])]]), sessionManager: {
    githubPr,
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
    writeFileSync(file, data, options) { assert.equal(options.mode, 0o600); if (failWrite) throw Error("disk full"); writes++; disk.set(file, data); },
    renameSync(from, to) { disk.set(to, disk.get(from)); disk.delete(from); }
  };
  const api = factory(engine, { fs, path: { join: (...parts) => parts.join("/") }, userData: "/profile", uuid: () => `uuid-${++count}`, now: () => clock });
  const check = () => api.check(session, pr);
  // One sweep is one check; the clock moves a minute per sweep like the focused sweep.
  const sweep = async (n = 1) => { for (let i = 0; i < n; i++) { await check(); clock += 60_000; } };
  return { api, engine, githubPr, budget, disk, sent, parked, record, set: v => { value = v; }, queue: (...v) => { queue = v; }, delivery: v => { delivery = v; }, writesFail: () => { failWrite = true; }, hook: v => { hook = v; }, calls: () => calls, writes: () => writes, tick: ms => { clock += ms; }, check, sweep };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

// --- verdicts (each needs the confirming second sweep to notify) -------------
await test("ready on two consecutive sweeps: one read each, notice on the second, repeat and restart deduplication", async () => {
  const h = harness();
  await h.sweep(); assert.equal(h.sent.length, 0); assert.equal(h.calls(), 1);
  await h.sweep(); assert.equal(h.sent.length, 1); assert.equal(h.calls(), 2);
  await h.sweep(); assert.equal(h.sent.length, 1);
  const restarted = harness(h.disk); await restarted.sweep(2); assert.equal(restarted.sent.length, 0);
  const [_id, message, _attachments, options] = h.sent[0];
  assert.match(message, /does not authorize merge, auto-merge, deployment/); assert.equal(options.initiator, "ci-monitor");
  assert.equal(options.origin.kind, "auto-continuation");
});
for (const mergeStateStatus of ["UNKNOWN", "BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "DRAFT", undefined]) {
  await test(`reject merge state ${mergeStateStatus}`, async () => { const h = harness(); h.set({ ...good(), mergeStateStatus }); await h.sweep(2); assert.equal(h.sent.length, 0); });
}
for (const overrides of [{ state: "CLOSED" }, { state: "MERGED" }, { state: undefined }, { isDraft: true }, { isDraft: undefined }, { reviewDecision: "CHANGES_REQUESTED" }, { reviewDecision: "REVIEW_REQUIRED" }, { reviewDecision: undefined }, { mergeable: "UNKNOWN" }, { mergeable: "CONFLICTING" }, { isMergeQueueEnabled: true }, { isMergeQueueEnabled: undefined }, { headRefOid: undefined }, { commits: undefined }]) {
  await test(`reject ${JSON.stringify(overrides)}`, async () => { const h = harness(); h.set({ ...good(), ...overrides }); await h.sweep(2); assert.equal(h.sent.length, 0); });
}
for (const conclusion of ["FAILURE", "CANCELLED", "SKIPPED", "NEUTRAL", "TIMED_OUT", "ACTION_REQUIRED", "STALE", null, undefined]) {
  await test(`reject check ${conclusion}`, async () => { const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = conclusion; h.set(p); await h.sweep(2); assert.equal(h.sent.length, 0); });
}
for (const isRequired of [true, false, undefined]) {
  await test(`skipped requirement ${isRequired} is explicit`, async () => {
    const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0] = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED", isRequired };
    h.set(p); await h.sweep(2); assert.equal(h.sent.length, isRequired === false ? 1 : 0);
  });
}
for (const conclusion of ["CANCELLED", "FAILURE", "NEUTRAL"]) {
  await test(`optional ${conclusion} still blocks after optional skipped check`, async () => {
    const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED", isRequired: false },
      { __typename: "CheckRun", status: "COMPLETED", conclusion, isRequired: false }
    ]; h.set(p); await h.sweep(2); assert.equal(h.sent.length, 0);
  });
}
await test("optional skip still requires CLEAN and successful rollup", async () => {
  for (const mergeStateStatus of ["UNSTABLE", "UNKNOWN", "CLEAN"]) {
    const h = harness(), p = good(); p.mergeStateStatus = mergeStateStatus;
    p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0] = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED", isRequired: false };
    p.commits.nodes[0].commit.statusCheckRollup.state = "PENDING";
    h.set(p); await h.sweep(2); assert.equal(h.sent.length, 0);
  }
});
for (const status of ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING"]) {
  await test(`reject pending ${status}`, async () => { const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].status = status; h.set(p); await h.sweep(2); assert.equal(h.sent.length, 0); });
}
await test("explicit no checks and approved reviews", async () => { const h = harness(), p = good(); p.reviewDecision = "APPROVED"; p.commits.nodes[0].commit.statusCheckRollup = null; h.set(p); await h.sweep(2); assert.equal(h.sent.length, 1); });
for (const mutation of [p => { p.commits.nodes[0].commit.oid = base; }, p => { p.commits.nodes[0].commit.statusCheckRollup = undefined; }, p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true; }, p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = []; }, p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: "Other" }]; }, p => { p.commits.nodes[0].commit.statusCheckRollup.state = "PENDING"; }]) {
  await test("reject incomplete/truncated/mismatched rollup", async () => { const h = harness(), p = good(); mutation(p); h.set(p); await h.sweep(2); assert.equal(h.sent.length, 0); });
}
for (const state of ["PENDING", "ERROR", "FAILURE", undefined]) {
  await test(`reject status context ${state}`, async () => { const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: "StatusContext", state }]; h.set(p); await h.sweep(2); assert.equal(h.sent.length, 0); });
}
await test("status context succeeds", async () => { const h = harness(), p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: "StatusContext", state: "SUCCESS" }]; h.set(p); await h.sweep(2); assert.equal(h.sent.length, 1); });

// --- consecutive-sweep confirmation ------------------------------------------
await test("HEAD/base change between sweeps restarts the confirmation", async () => {
  for (const field of ["headRefOid", "baseRefOid"]) {
    const h = harness(); const moved = field === "headRefOid" ? atHead(other) : { ...good(), baseRefOid: other };
    h.queue(good(), moved); await h.sweep(2); assert.equal(h.sent.length, 0, field);
    h.set(moved); await h.sweep(); assert.equal(h.sent.length, 1, field); assert.equal(h.calls(), 3);
  }
});
await test("second sweep pending/failed/partial/unknown fails closed and restarts the confirmation", async () => {
  for (const second of [Error("offline"), { data: { repository: { pullRequest: good() } }, errors: [{ type: "FORBIDDEN" }] }, { ...good(), mergeStateStatus: "BLOCKED" }, { ...good(), mergeStateStatus: "UNKNOWN" }, null]) {
    const h = harness(); h.queue(good(), second, good()); await h.sweep(3); assert.equal(h.sent.length, 0);
    await h.sweep(); assert.equal(h.sent.length, 1);
  }
});
await test("outage never rearms a delivered transition", async () => { const h = harness(); await h.sweep(2); h.set(Error("offline")); h.tick(11 * 60_000); await h.sweep(); h.set({ ...good(), mergeStateStatus: "UNKNOWN" }); h.tick(11 * 60_000); await h.sweep(); h.set(good()); h.tick(11 * 60_000); await h.sweep(3); assert.equal(h.sent.length, 1); });
await test("known pending to ready transition rearms, including restart", async () => { const h = harness(); await h.sweep(2); h.set({ ...good(), mergeStateStatus: "BLOCKED" }); h.tick(11 * 60_000); await h.sweep(); const restarted = harness(h.disk); await restarted.sweep(2); assert.equal(restarted.sent.length, 1); });
await test("new HEAD is a new notification", async () => { const h = harness(); await h.sweep(2); h.set(atHead(other)); h.tick(11 * 60_000); await h.sweep(2); assert.equal(h.sent.length, 2); });

// --- cost rules ----------------------------------------------------------------
await test("a notified head is re-read at most every 10 minutes", async () => {
  const h = harness(); await h.sweep(2); assert.equal(h.calls(), 2);
  await h.sweep(9); assert.equal(h.calls(), 2, "no read inside the 10 minutes");
  await h.sweep(); assert.equal(h.calls(), 3, "one read once 10 minutes passed");
  await h.sweep(5); assert.equal(h.calls(), 3);
  assert.equal(h.sent.length, 1);
});
await test("the 10-minute re-read sees a new head; its confirming read is not throttled", async () => {
  const h = harness(); await h.sweep(2); h.set(atHead(other)); h.tick(10 * 60_000);
  await h.sweep(); assert.equal(h.sent.length, 1); await h.sweep(); assert.equal(h.sent.length, 2);
});
await test("a regression seen by the throttled re-read lifts the throttle", async () => {
  const h = harness(); await h.sweep(2); h.set({ ...good(), mergeStateStatus: "BLOCKED" }); h.tick(10 * 60_000); await h.sweep();
  const before = h.calls(); h.set(good()); await h.sweep(2); assert.equal(h.calls(), before + 2); assert.equal(h.sent.length, 2);
});
await test("budget guard: low GraphQL budget, open rate-limit window or a missing guard skip the read", async () => {
  for (const mutate of [h => { h.budget.graphql.remaining = 120; }, h => { h.budget.graphql.rateLimited = true; }, h => { delete h.budget.graphql.rateLimited; }, h => { delete h.budget.graphql; }, h => { delete h.githubPr.readBudgets; }, h => { delete h.githubPr.graphqlBudgetLow; }, h => { h.githubPr.readBudgets = () => { throw Error("boom"); }; }]) {
    const h = harness(); mutate(h); await h.sweep(3); assert.equal(h.calls(), 0); assert.equal(h.sent.length, 0);
  }
  const unknown = harness(); unknown.budget.graphql.remaining = undefined; await unknown.sweep(2); assert.equal(unknown.calls(), 2, "an unknown budget reads, like upstream's own guard");
});
await test("budget recovery keeps a pending confirmation", async () => {
  const h = harness(); await h.sweep(); h.budget.graphql.remaining = 10; await h.sweep(3); assert.equal(h.calls(), 1);
  h.budget.graphql.remaining = 4000; await h.sweep(); assert.equal(h.sent.length, 1); assert.equal(h.calls(), 2);
});
await test("undelivered sends back off 1, 3, 7, 15 sweeps and reset on delivery", async () => {
  const h = harness(); h.delivery({ delivered: false }); await h.sweep(2); assert.equal(h.sent.length, 1);
  const sendsAfter = []; for (let i = 0; i < 30; i++) { await h.sweep(); sendsAfter.push(h.sent.length); }
  // Send #2 one sweep after skipping 1, #3 after skipping 3, #4 after skipping 7, #5 after skipping 15.
  assert.deepEqual([sendsAfter.indexOf(2), sendsAfter.indexOf(3), sendsAfter.indexOf(4), sendsAfter.indexOf(5)], [1, 5, 13, 29]);
  h.delivery({ delivered: true }); const at = h.sent.length; await h.sweep(16); assert.equal(h.sent.length, at + 1);
  const t = harness(); t.delivery(Error("send failed")); await t.sweep(2); await t.sweep(); assert.equal(t.sent.length, 1); await t.sweep(); assert.equal(t.sent.length, 2);
});
await test("the ledger is written only when it changes", async () => {
  const h = harness(); h.set({ ...good(), mergeStateStatus: "BLOCKED" }); await h.sweep(); assert.equal(h.writes(), 1);
  await h.sweep(5); assert.equal(h.writes(), 1, "repeated blocked verdicts do not rewrite the file");
  h.set(good()); await h.sweep(); assert.equal(h.writes(), 1, "an unconfirmed ready writes nothing");
  await h.sweep(); assert.equal(h.writes(), 3, "the pre-send write and the delivery write");
});

// --- delivery -------------------------------------------------------------------
for (const delivery of [{ delivered: false }, Error("send failed")]) {
  await test("failed delivery remains retriable after restart", async () => { const h = harness(); h.delivery(delivery); await h.sweep(2); const restarted = harness(h.disk); await restarted.sweep(2); assert.equal(restarted.sent.length, 1); });
}
await test("queued acceptance, completion and dropped delivery", async () => {
  const h = harness(); h.delivery({ delivered: true, queued: true }); await h.sweep(3); assert.equal(h.sent.length, 1);
  const id = h.sent[0][3].messageUuid; h.api.completed(session.sessionId, id);
  const restarted = harness(h.disk); await restarted.sweep(2); assert.equal(restarted.sent.length, 0);
  h.api.dropped(session.sessionId, [id], "lost"); await h.sweep(); assert.equal(h.sent.length, 2);
});
await test("a cancelled drop (deleted notice or Stop) is dismissed, never rearmed", async () => {
  const h = harness(); h.delivery({ delivered: true, queued: true }); await h.sweep(2); assert.equal(h.sent.length, 1);
  h.api.dropped(session.sessionId, [h.sent[0][3].messageUuid], "cancelled"); h.parked.clear();
  await h.sweep(30); assert.equal(h.sent.length, 1);
  assert.equal(JSON.parse(h.disk.get(LEDGER)).states["github.com/owner/repo#1"].delivery, "cancelled");
  const restarted = harness(h.disk); await restarted.sweep(3); assert.equal(restarted.sent.length, 0);
  const moved = harness(h.disk); moved.set(atHead(other)); await moved.sweep(2); assert.equal(moved.sent.length, 1, "a new head notifies again");
});
await test("a cancelled drop while sendMessage resolves is dismissed too", async () => {
  const h = harness(); h.delivery({ delivered: true, queued: true }); h.hook(id => h.api.dropped(session.sessionId, [id], "cancelled"));
  await h.sweep(2); h.hook(undefined); h.parked.clear(); await h.sweep(20); assert.equal(h.sent.length, 1);
});
await test("surviving parked queue is not duplicated on restart", async () => { const h = harness(); h.delivery({ delivered: true, queued: true }); await h.sweep(2); const restarted = harness(h.disk, h.parked); await restarted.sweep(2); assert.equal(restarted.sent.length, 0); restarted.api.completed(session.sessionId, h.sent[0][3].messageUuid); const again = harness(h.disk); await again.sweep(2); assert.equal(again.sent.length, 0); });
await test("unconfirmed queue retries after restart", async () => { const h = harness(); h.delivery({ delivered: true, queued: true }); await h.sweep(2); const restarted = harness(h.disk); await restarted.sweep(2); assert.equal(restarted.sent.length, 1); });
await test("completion/drop while sendMessage resolves", async () => {
  for (const dropped of [false, true]) { const h = harness(); h.delivery({ delivered: true, queued: true }); h.hook(id => dropped ? h.api.dropped(session.sessionId, [id], "lost") : h.api.completed(session.sessionId, id)); await h.sweep(2); h.hook(undefined); await h.sweep(); assert.equal(h.sent.length, dropped ? 2 : 1); }
});
await test("completion is banked but not persisted before acceptance", async () => {
  const h = harness(); h.delivery({ delivered: false });
  h.hook(id => { h.api.completed(session.sessionId, id); const ledger = JSON.parse(h.disk.get(LEDGER)); assert.equal(ledger.states["github.com/owner/repo#1"].notified, false); });
  await h.sweep(2); const restarted = harness(h.disk); await restarted.sweep(2); assert.equal(restarted.sent.length, 1);
});
await test("queued stale readiness is withdrawn", async () => { const h = harness(); h.delivery({ delivered: true, queued: true }); await h.sweep(2); h.set({ ...good(), mergeStateStatus: "BLOCKED" }); await h.sweep(); assert.equal(h.parked.size, 0); });
await test("cap and disk failure do not send", async () => { const h = harness(); h.engine.sessionManager.cliGovernor.isAtCap = () => true; await h.sweep(2); assert.equal(h.sent.length, 0); h.engine.sessionManager.cliGovernor.isAtCap = () => false; h.writesFail(); await h.sweep(2); assert.equal(h.sent.length, 0); });
await test("corrupt persistence fails closed", async () => { const h = harness(new Map([[LEDGER, "invalid json"]])); await h.sweep(2); assert.equal(h.sent.length, 0); assert.equal(h.calls(), 0); });
await test("PR detached during a read cannot wake", async () => { const h = harness(); await h.sweep(); h.githubPr.ghRest.graphqlWithErrors = async () => { h.engine.diffState.clear(); return { data: { repository: { pullRequest: good() } }, errors: [] }; }; await h.sweep(); assert.equal(h.sent.length, 0); });
await test("concurrent checks deduplicate", async () => { const h = harness(); await h.sweep(); await Promise.all([h.check(), h.check()]); assert.equal(h.sent.length, 1); });
await test("host and repository are separate identities", async () => {
  const h = harness(); const enterprise = { ...pr, host: "git.example.org" }, second = { ...pr, repo: "Owner/Other" };
  h.record.prs.push({ ...enterprise, state: "OPEN", autoFix: true }, { ...second, state: "OPEN", autoFix: true });
  h.engine.diffState.get(session.sessionId).set("git.example.org\nowner/repo#1", {}); h.engine.diffState.get(session.sessionId).set("owner/other#1", {});
  for (let i = 0; i < 2; i++) { await h.check(); await h.api.check(session, enterprise); await h.api.check(session, second); }
  assert.equal(h.sent.length, 3);
});
for (const mutation of [h => { h.record.isArchived = true; }, h => { h.record.prs[0].autoFix = false; }, h => { h.record.prs[0].dismissed = true; }, h => { h.record.prs = []; }]) {
  await test("monitor disabled during a read cannot wake", async () => {
    const h = harness(); await h.sweep();
    h.githubPr.ghRest.graphqlWithErrors = async () => { mutation(h); return { data: { repository: { pullRequest: good() } }, errors: [] }; };
    await h.sweep(); assert.equal(h.sent.length, 0);
  });
}
await test("new HEAD withdraws a parked older readiness wake", async () => {
  const h = harness(); h.delivery({ delivered: true, queued: true }); await h.sweep(2);
  h.set(atHead(other)); await h.sweep(); assert.equal(h.parked.size, 0, "withdrawn on the first read of the new head");
  await h.sweep(); assert.equal(h.sent.length, 2); assert.equal(h.parked.size, 1);
});
await test("original engine closure rearms a later reopen at the same HEAD", async () => {
  const h = harness(); await h.sweep(2); const entry = h.engine.diffState.get(session.sessionId).get("owner/repo#1"); entry.closed = true; await h.sweep(); assert.equal(h.sent.length, 1);
  entry.closed = false; await h.sweep(2); assert.equal(h.sent.length, 2);
});
await test("unknown check fields do not rearm a completed notice", async () => {
  const h = harness(); await h.sweep(2); const p = good(); p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = undefined;
  h.set(p); h.tick(11 * 60_000); await h.sweep(); h.set(good()); await h.sweep(3); assert.equal(h.sent.length, 1);
});

// --- the compiled wrapper ---------------------------------------------------------
await test("compiled patch: gated, contained, idempotent wrapper over the real method shapes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "merge-ready-patch-"));
  try {
    const target = join(directory, "fixture.js");
    const binary = join(ROOT, "patches/community/add_feature_autofix_merge_ready");
    const fixture = 'class Engine {async checkSession($s,p$){this.original=(this.original||0)+1;this.diffState=this.diffState||new Map;return "orig"}handleTurnCompleted($s,m$){try{this.completedOriginal=true}catch{}}handleSendsDroppedUnsent($s,m$,r$){try{this.droppedOriginal=r$}catch{}}finish(c$,i$,e$,s$,p$,a$){c$&&i$.query===e$.queryObj&&s$!==void 0&&!s$.adoptedByStartedCommand&&p$.health==="healthy"&&this.deps.emit("turnCompleted",a$,s$.userMessageUuid)}}';
    writeFileSync(target, fixture);
    let result = spawnSync(binary, [target], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
    const patched = readFileSync(target, "utf8");
    assert.match(patched, /async checkSession\(\$s,p\$\)\{let __cdbAfmrR=await this\.__cdbOriginalCheckSession\(\$s,p\$\);if\(process\.platform==="linux"&&globalThis\.__cdbAutoFixMergeReadyEnabled\?\.\(\)===true\)\{try\{this\.__cdbMergeReady\?\?=/);
    assert.match(patched, /handleTurnCompleted\(\$s,m\$\)\{try\{this\.__cdbMergeReady\?\.completed\(\$s,m\$\)\}catch\(__cdbAfmrE\)\{globalThis\.__cdbDiag\?\.\("\[merge-ready\] "\+String\(__cdbAfmrE\)\)\}try\{/);
    assert.match(patched, /handleSendsDroppedUnsent\(\$s,m\$,r\$\)\{try\{this\.__cdbMergeReady\?\.dropped\(\$s,m\$,r\$\)\}catch\(__cdbAfmrE\)\{/);
    result = spawnSync(binary, [target], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(target, "utf8"), patched);
    assert.match(result.stdout, /already present/);

    const load = (platform, enabled, diag = []) => {
      const ctx = { process: { platform, pid: 1 }, require: () => { throw Error("no require in the fixture"); } };
      ctx.globalThis = ctx; ctx.__cdbDiag = m => diag.push(m);
      if (enabled !== undefined) ctx.__cdbAutoFixMergeReadyEnabled = () => enabled;
      return vm.runInNewContext(patched + ';Engine', ctx);
    };
    // Switch on: the original runs first, then the helper; callbacks pass every argument.
    const Engine = load("linux", true);
    const engine = new Engine(); let checks = 0; const completed = [], dropped = [];
    engine.__cdbMergeReady = { check: async () => { assert.equal(engine.original, 1); checks++; }, completed: (...a) => { completed.push(a); }, dropped: (...a) => { dropped.push(a); } };
    assert.equal(await engine.checkSession(session, pr), "orig");
    engine.handleTurnCompleted("session", "id"); engine.handleSendsDroppedUnsent("session", ["id"], "cancelled");
    assert.equal(checks, 1); assert.deepEqual(completed, [["session", "id"]]); assert.deepEqual(dropped, [["session", ["id"], "cancelled"]]);
    assert.equal(engine.completedOriginal, true); assert.equal(engine.droppedOriginal, "cancelled");

    // Switch off, absent or not exactly true, or not Linux: no helper, no read.
    for (const [platform, enabled] of [["linux", false], ["linux", undefined], ["linux", "yes"], ["win32", true]]) {
      const E = load(platform, enabled); const e = new E(); let helperCalls = 0;
      e.__cdbMergeReady = { check: async () => { helperCalls++; } };
      assert.equal(await e.checkSession(session, pr), "orig"); assert.equal(e.original, 1); assert.equal(helperCalls, 0, `${platform}/${enabled}`);
      const fresh = new E(); await fresh.checkSession(session, pr); assert.equal(fresh.__cdbMergeReady, undefined);
    }

    // Contained: a throw from the factory (diffState access, missing require),
    // from check() or from a callback never rejects checkSession or skips the
    // original callback body.
    const diag = [];
    const Contained = load("linux", true, diag);
    // The real helper on an engine whose diffState access throws (the throw
    // lands before the helper's own try), and a factory that cannot start.
    const thrower = { sessionManager: { githubPr: {} } };
    Object.defineProperty(thrower, "diffState", { get() { throw Error("diffState moved"); } });
    const throwing = new Contained();
    throwing.__cdbMergeReady = factory(thrower, { fs: { readFileSync() { throw Object.assign(Error("missing"), { code: "ENOENT" }); } }, path: { join: (...p) => p.join("/") }, userData: "/p", uuid: () => "u", now: () => 0 });
    assert.equal(await throwing.checkSession(session, pr), "orig");
    const noFactory = new Contained();
    assert.equal(await noFactory.checkSession(session, pr), "orig");
    const rejecting = new Contained(); rejecting.__cdbMergeReady = { check: async () => { throw Error("helper bug"); }, completed: () => { throw Error("cb bug"); }, dropped: () => { throw Error("cb bug"); } };
    assert.equal(await rejecting.checkSession(session, pr), "orig");
    rejecting.handleTurnCompleted("s", "m"); rejecting.handleSendsDroppedUnsent("s", ["m"], "lost");
    assert.equal(rejecting.completedOriginal, true); assert.equal(rejecting.droppedOriginal, "lost");
    assert.ok(diag.some(m => /^\[merge-ready\] .*helper bug/.test(m)) && diag.filter(m => /cb bug/.test(m)).length === 2, JSON.stringify(diag));
    assert.ok(diag.some(m => /diffState moved/.test(m)) && diag.some(m => /no require/.test(m)), "the diffState and factory failures are logged: " + JSON.stringify(diag));
    // In a sweep: Promise.all over a batch still sees every original result.
    const batch = [noFactory, throwing, rejecting];
    assert.deepEqual(await Promise.all(batch.map(e => e.checkSession(session, pr))), ["orig", "orig", "orig"]);

    // Anchors: missing, duplicated, or a partial / old-shape injection fail the build.
    const oldShape = fixture.replace('async checkSession($s,p$){', 'async checkSession($s,p$){await this.__cdbOriginalCheckSession($s,p$);if(process.platform==="linux"){this.__cdbMergeReady??=(function(){})(this);await this.__cdbMergeReady.check($s,p$)}}async __cdbOriginalCheckSession($s,p$){');
    for (const invalid of [fixture.replace('async checkSession', 'async changed'), fixture + fixture, patched.replace('this.__cdbMergeReady?.completed(', 'this.broken('), patched.replace('catch(__cdbAfmrE){globalThis', 'catch(__cdbAfmrE){void globalThis'), oldShape]) {
      writeFileSync(target, invalid); result = spawnSync(binary, [target], { encoding: "utf8" }); assert.notEqual(result.status, 0);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// --- settings: key, channels, bridge, page row --------------------------------------
await test("settings: autoFixMergeReady predicate, channels, lock and win32 refusal", async () => {
  const EXTRA_BIN = join(ROOT, "patches/core/add_feature_extra_settings");
  accessSync(EXTRA_BIN, constants.X_OK);
  const require2 = createRequire(import.meta.url);
  const Module = require2("module");
  const run = async (platform, body) => {
    const dir = mkdtempSync(join(tmpdir(), "cdb-afmr-extra-"));
    const mod = join(dir, "extra.cjs");
    writeFileSync(mod, '"use strict";\nfunction FHa(e=[]){let t=G().type==="3p"&&ou()==="1p"?[...e,j$t]:e;a.app.isPackaged?Mj(!0,t):fj(t)}\n' +
      // ...and the navigation / VM-probe capture anchors (sub-patches C, D); never called.
      'var Hrr,Urr;function Yrr(){return Urr??=(async()=>{let t,n,r,s;return Hrr={qemuPath:t,firmwarePath:n,virtiofsdPath:r,virtiofsdAptInstallable:!0,kvm:s},Hrr})(),Urr}function Xrr(){return Hrr}\n' +
      'function nav0(){let Uy=go(Hy,"Navigation",Xy,{events:[["navigate",[["path",I]]]]});return Uy}\n');
    execFileSync(EXTRA_BIN, [mod], { stdio: "ignore" });
    const userData = join(dir, "Claude"); mkdirSync(userData, { recursive: true });
    const handlers = {};
    const fakeElectron = {
      app: { getPath: () => userData, on: () => {}, once: () => {}, relaunch: () => {}, exit: () => {} },
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} },
      shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} },
    };
    const orig = Module._load;
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Module._load = function (req, ...rest) { return req === "electron" ? fakeElectron : orig.call(this, req, ...rest); };
    Object.defineProperty(process, "platform", { value: platform });
    globalThis.__cdbDiag = () => {};
    delete globalThis.__cdbAutoFixMergeReadyEnabled;
    try { require2(mod); } finally { Module._load = orig; Object.defineProperty(process, "platform", realPlatform); }
    const ev = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
    try {
      await body({ call: async (ch, ...a) => handlers[ch](ev, ...a), handlers, json: join(userData, "claude-desktop-extra.json"), jsonc: join(userData, "claude-desktop-extra.jsonc") });
    } finally { rmSync(dir, { recursive: true, force: true }); delete globalThis.__cdbAutoFixMergeReadyEnabled; }
  };
  await run("linux", async ({ call, handlers, json, jsonc }) => {
    assert.equal(typeof globalThis.__cdbAutoFixMergeReadyEnabled, "function");
    assert.equal(globalThis.__cdbAutoFixMergeReadyEnabled(), false, "off by default");
    assert.ok(handlers["cdb-autofix-merge-ready:read"] && handlers["cdb-autofix-merge-ready:set"]);
    let r = await call("cdb-autofix-merge-ready:read"); assert.deepEqual([r.ok, r.enabled, r.lockedByJsonc], [true, false, null]);
    r = await call("cdb-autofix-merge-ready:set", true); assert.equal(r.ok, true);
    assert.equal(JSON.parse(readFileSync(json, "utf8")).autoFixMergeReady, true);
    assert.equal(globalThis.__cdbAutoFixMergeReadyEnabled(), true, "read live, no restart");
    r = await call("cdb-autofix-merge-ready:set", "yes"); assert.equal(r.ok, false);
    r = await call("cdb-autofix-merge-ready:set", false); assert.equal(r.ok, true);
    assert.equal("autoFixMergeReady" in JSON.parse(readFileSync(json, "utf8")), false, "off removes the key");
    assert.equal(globalThis.__cdbAutoFixMergeReadyEnabled(), false);
    writeFileSync(jsonc, '{\n  // hand-edited\n  "autoFixMergeReady": true,\n}\n');
    assert.equal(globalThis.__cdbAutoFixMergeReadyEnabled(), true, ".jsonc wins");
    r = await call("cdb-autofix-merge-ready:read"); assert.deepEqual([r.enabled, r.lockedByJsonc], [true, true]);
    r = await call("cdb-autofix-merge-ready:set", false); assert.equal(r.ok, false); assert.equal(r.lockedByJsonc, true);
    writeFileSync(jsonc, '{ "autoFixMergeReady": false }'); writeFileSync(json, '{ "autoFixMergeReady": true }');
    assert.equal(globalThis.__cdbAutoFixMergeReadyEnabled(), false, ".jsonc false beats .json true");
  });
  await run("win32", async ({ call }) => {
    assert.equal(globalThis.__cdbAutoFixMergeReadyEnabled, undefined, "no predicate off Linux");
    for (const ch of ["cdb-autofix-merge-ready:read", "cdb-autofix-merge-ready:set"]) {
      const r = await call(ch, true); assert.equal(r.ok, false); assert.match(r.error, /Linux only/);
    }
  });
});
await test("settings: bridge methods and the Community page row", async () => {
  const calls = []; let api = null;
  vm.runInNewContext(readFileSync(join(ROOT, "js/extra_settings_bridge.js"), "utf8"), vm.createContext({
    require: () => ({ contextBridge: { exposeInMainWorld: (_n, a) => { api = a; } }, ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); } } }),
  }));
  api.autoFixMergeReadyRead(); api.autoFixMergeReadySet("yes"); api.autoFixMergeReadySet(true);
  assert.deepEqual(calls, [["cdb-autofix-merge-ready:read"], ["cdb-autofix-merge-ready:set", false], ["cdb-autofix-merge-ready:set", true]]);
  const page = readFileSync(join(ROOT, "js/extra_settings_page.js"), "utf8");
  const row = /function renderAutoFixMergeReadyRow\(panel\) \{[\s\S]*?\n {2}\}\n/.exec(page);
  assert.ok(row);
  assert.match(row[0], /title: "Auto-fix notices: ready to merge, comments after merge"/);
  assert.match(row[0], /passes on new comments after it merges/); assert.match(row[0], /7 days/); assert.match(row[0], /never merges/);
  assert.match(row[0], /read: "autoFixMergeReadyRead",\s*write: "autoFixMergeReadySet"/);
  assert.match(row[0], /one GitHub read per Auto-fix PR/); assert.match(row[0], /one model turn per notice/); assert.match(row[0], /Applies live/);
  assert.equal(row[0].includes(String.fromCharCode(0x2014)), false);
  assert.match(page, /var FEATURE_GROUPS = [\s\S]*?renderAutoFixMergeReadyRow/);
});
console.log(`${passed} merge-ready tests passed`);
