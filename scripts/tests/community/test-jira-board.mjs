#!/usr/bin/env node
// Jira board view: board column configuration and the drop rule in js/jira_tracker_client.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SITE = "https://acme.atlassian.net";
const CREDS = { site: SITE, email: "dev@example.com", token: "jira-board-test-token", route: "site", cloudId: "" };
const plain = (x) => JSON.parse(JSON.stringify(x));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("PASS " + name); };

function response(status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text };
}
function client(transitions, extra = {}) {
  const posts = [], gets = [];
  const ctx = vm.createContext({ process: { platform: "linux" }, Buffer, URL, AbortController, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(join(ROOT, "js/jira_tracker_client.js"), "utf8"), ctx);
  const fetch = async (url, init) => {
    if (init.method === "POST") { posts.push(JSON.parse(init.body)); return response(204); }
    gets.push(url);
    for (const [part, answer] of Object.entries(extra)) if (url.includes(part)) return answer();
    if (url.includes("/transitions")) return response(200, { transitions });
    return response(200, { key: "B2-1", fields: { summary: "x", status: { id: "10", name: "QA", statusCategory: { key: "indeterminate" } } } });
  };
  return { c: ctx.__cdbJiraClientFactory({ fetch }), posts, gets };
}
const T = (id, toId, name, needs) => ({ id, name, to: { id: toId, name, statusCategory: { key: "indeterminate" } }, ...(needs ? { fields: { f: { required: true, hasDefaultValue: false } } } : {}) });

await test("board configuration: columns in order with their status ids; junk and refusals handled", async () => {
  const cfg = { columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1" }] }, { name: "In Progress", statuses: [{ id: "3" }, { id: "4" }, { id: "x y" }] },
    { name: "QA", statuses: [{ id: "10" }] }, { name: "Empty", statuses: [] }, { statuses: [{ id: "9" }] }, null, { name: "Done", statuses: [{ id: "5" }] }] } };
  const h = client([], { "/configuration": () => response(200, cfg) });
  const r = plain(await h.c.boardConfig(CREDS, 15));
  assert.deepEqual(r, { ok: true, columns: [{ name: "To Do", statusIds: ["1"] }, { name: "In Progress", statusIds: ["3", "4"] }, { name: "QA", statusIds: ["10"] }, { name: "Empty", statusIds: [] }, { name: "Done", statusIds: ["5"] }] });
  assert.ok(h.gets[0].endsWith("/rest/agile/1.0/board/15/configuration"));
  assert.equal(plain(await h.c.boardConfig(CREDS, "15/../1")).ok, false);
  const no = client([], { "/configuration": () => response(401, { message: "Unauthorized; scope does not match" }) });
  const f = plain(await no.c.boardConfig(CREDS, 15));
  assert.equal(f.status, 401); assert.equal(f.detail, "Unauthorized; scope does not match");
  assert.equal(no.gets.length, 1, "no route re-detection");
});
await test("drop: exactly one usable transition into the column's statuses runs it and returns the fresh record", async () => {
  const h = client([T("11", "3", "Start"), T("21", "10", "Send to QA"), T("22", "4", "Uphill", true)]);
  const r = plain(await h.c.drop(CREDS, "B2-1", ["10", "11"], ""));
  assert.equal(r.kind, "done"); assert.equal(r.record.status, "QA"); assert.deepEqual(h.posts, [{ transition: { id: "21" } }]);
});
await test("drop: several usable transitions into a multi-status column ask which; a pick must be one of them", async () => {
  const h = client([T("11", "3", "Start"), T("12", "4", "Uphill"), T("13", "5", "Downhill"), T("14", "4", "Needs", true), T("21", "10", "QA")]);
  const r = plain(await h.c.drop(CREDS, "B2-1", ["3", "4", "5"], ""));
  assert.equal(r.kind, "choose");
  assert.deepEqual(r.options.map((o) => [o.id, o.name, o.toStatus]), [["11", "Start", "Start"], ["12", "Uphill", "Uphill"], ["13", "Downhill", "Downhill"]], "needsFields ones are left out");
  assert.equal(h.posts.length, 0);
  assert.equal(plain(await h.c.drop(CREDS, "B2-1", ["3", "4", "5"], "12")).kind, "done");
  assert.equal(plain(await h.c.drop(CREDS, "B2-1", ["3", "4", "5"], "14")).kind, "refused", "a needsFields pick is refused");
  assert.equal(plain(await h.c.drop(CREDS, "B2-1", ["3", "4", "5"], "21")).kind, "refused", "a transition into another column is refused");
  assert.deepEqual(h.posts, [{ transition: { id: "12" } }]);
});
await test("drop: none, or only needsFields transitions, sends the card back with a message; bad input never reaches Jira", async () => {
  const none = client([T("21", "10", "QA")]);
  assert.deepEqual(plain(await none.c.drop(CREDS, "B2-1", ["1"], "")), { ok: true, kind: "refused", message: "No transition leads to that column." });
  const needs = client([T("21", "1", "Reopen", true)]);
  assert.match(plain(await needs.c.drop(CREDS, "B2-1", ["1"], "")).message, /needs fields/);
  assert.equal(none.posts.length + needs.posts.length, 0);
  const bad = client([T("21", "1", "Reopen")]);
  for (const args of [["b2-1", ["1"], ""], ["B2-1", [], ""], ["B2-1", ["1 OR 2"], ""], ["B2-1", "1", ""], ["B2-1", ["1"], "x"]]) assert.equal(plain(await bad.c.drop(CREDS, ...args)).ok, false, JSON.stringify(args));
  assert.equal(bad.gets.length + bad.posts.length, 0);
});
await test("project statuses: every workflow status per issue type, from the core API", async () => {
  const body = [{ name: "Bug", statuses: [{ id: "1", name: "To Do", statusCategory: { key: "new" } }, { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } }, { id: "x" }] },
    { name: "Story", statuses: [{ id: "1", name: "To Do", statusCategory: { key: "new" } }, { id: "9", name: "Done", statusCategory: { key: "done" } }] }, { statuses: "junk" }];
  const h = client([], { "/project/B2/statuses": () => response(200, body) });
  const r = plain(await h.c.projectStatuses(CREDS, "B2"));
  assert.deepEqual(r, { ok: true, types: [{ type: "Bug", statuses: [{ id: "1", name: "To Do", category: "todo" }, { id: "3", name: "In Progress", category: "inprogress" }] },
    { type: "Story", statuses: [{ id: "1", name: "To Do", category: "todo" }, { id: "9", name: "Done", category: "done" }] }] });
  assert.ok(h.gets[0].endsWith("/rest/api/3/project/B2/statuses"));
  assert.equal(plain(await h.c.projectStatuses(CREDS, "b2")).ok, false);
  assert.equal(h.gets.length, 1);
});
console.log(`PASS ${passed} Jira board tests`);
