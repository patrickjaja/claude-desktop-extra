#!/usr/bin/env node
// js/jira_tracker_client.js against a fake fetch: route detection, tenant_info, host allowlist, redirects, errors, queue, secrets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SITE = "https://acme.atlassian.net", GW = "https://api.atlassian.com/ex/jira/cloud-abc";
const EMAIL = "dev@example.com", TOKEN = "jira-test-token-0123456789abcdef";
const BASIC = "Basic " + Buffer.from(EMAIL + ":" + TOKEN).toString("base64");
const CREDS = { site: SITE, email: EMAIL, token: TOKEN, route: "", cloudId: "" };
const plain = (x) => JSON.parse(JSON.stringify(x));
const ISSUE = { key: "ACME-7", fields: { summary: "Fix rounding", status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
  issuetype: { name: "Bug" }, priority: { name: "High" }, assignee: { displayName: "Ada" }, project: { key: "ACME" }, updated: "2026-11-01T10:00:00.000+0000",
  labels: ["payroll", 7], description: { type: "doc", version: 1, content: [] } } };

function load(platform = "linux") {
  const ctx = vm.createContext({ process: { platform }, Buffer, URL, AbortController, setTimeout, clearTimeout, console });
  vm.runInContext(readFileSync(join(ROOT, "js/jira_tracker_client.js"), "utf8"), ctx);
  return ctx;
}
function response(status, body, headers = {}) {
  const bin = Buffer.isBuffer(body) ? body : null;
  const text = bin ? "" : body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, ok: status >= 200 && status < 300, type: "basic", headers: { get: (k) => h[k.toLowerCase()] ?? null }, text: async () => text,
    arrayBuffer: async () => { const b = bin || Buffer.from(text); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } };
}
function harness(routes, opts = {}) {
  const requests = [], logs = [], routesSaved = [], sleeps = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect });
    for (const [match, answer] of routes) if (match(url, init)) return answer(url, init);
    return response(404, { errorMessages: ["no route"] });
  };
  const client = load().__cdbJiraClientFactory({ fetch: opts.fetch || fetch, log: (m) => logs.push(m), saveRoute: (r, id) => routesSaved.push([r, id]),
    sleep: async (ms) => { sleeps.push(ms); }, now: () => 1_800_000_000_000, timeoutMs: opts.timeoutMs });
  return { client, requests, logs, routesSaved, sleeps };
}
const at = (prefix, path) => (url) => url.split("?")[0] === prefix + path;
const myselfOk = (prefix) => [at(prefix, "/rest/api/3/myself"), () => response(200, { displayName: "Ada" })];
const myself401 = (prefix) => [at(prefix, "/rest/api/3/myself"), () => response(401, {})];
const tenantInfo = [at(SITE, "/_edge/tenant_info"), () => response(200, { cloudId: "cloud-abc" })];
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("PASS " + name); };

await test("constants match the spec; win32 installs nothing", () => {
  assert.deepEqual(plain(harness([]).client.constants), { MAX_CONCURRENT: 4, TIMEOUT_MS: 15000, RETRY_CAP_MS: 30000, PAGE_SIZE: 50, GATEWAY_HOST: "api.atlassian.com" });
  assert.equal(load("win32").__cdbJiraClientFactory, undefined);
  const withSort = load().__cdbJiraClientFactory.withSort;
  assert.equal(withSort("assignee = currentUser()", "updated"), "assignee = currentUser() ORDER BY updated DESC");
  assert.equal(withSort("assignee = currentUser()", "priority"), "assignee = currentUser() ORDER BY priority DESC, updated DESC");
  assert.equal(withSort("x = 1", "created"), "x = 1 ORDER BY created DESC");
  assert.equal(withSort("x = 1", "key"), "x = 1 ORDER BY key ASC");
  assert.equal(withSort("project = B2 order by rank asc", "updated"), "project = B2 ORDER BY updated DESC", "a chosen sort replaces the user's ORDER BY");
  assert.equal(withSort('summary ~ "order by me" ORDER BY created', "key"), 'summary ~ "order by me" ORDER BY key ASC', "ORDER BY inside a quoted string is text");
  assert.equal(withSort("summary ~ 'a\\'b order by' and x = 1", "key"), "summary ~ 'a\\'b order by' and x = 1 ORDER BY key ASC");
  assert.equal(withSort("project = B2 ORDER BY rank", ""), "project = B2 ORDER BY rank", "no sort keeps the user's own ORDER BY");
  assert.equal(withSort("project = B2", "bogus"), "project = B2", "an unknown sort changes nothing");
});
await test("site route: Basic credential on the site, no tenant_info, route saved once", async () => {
  const h = harness([myselfOk(SITE)]);
  assert.deepEqual(plain(await h.client.myself(CREDS)), { ok: true, displayName: "Ada" });
  assert.deepEqual(h.requests.map((r) => r.url), [SITE + "/rest/api/3/myself", SITE + "/rest/api/3/myself"]);
  assert.ok(h.requests.every((r) => r.headers.authorization === BASIC && r.redirect === "manual"));
  assert.deepEqual(h.routesSaved, [["site", ""]]);
  const stored = harness([myselfOk(SITE)]);
  await stored.client.myself({ ...CREDS, route: "site" });
  assert.equal(stored.requests.length, 1); assert.deepEqual(stored.routesSaved, []);
});
await test("scoped token: site 401 -> tenant_info without a credential -> gateway, route remembered", async () => {
  const h = harness([myself401(SITE), tenantInfo, myselfOk(GW)]);
  assert.equal((await h.client.myself(CREDS)).ok, true);
  assert.deepEqual(h.requests.map((r) => r.url), [SITE + "/rest/api/3/myself", SITE + "/_edge/tenant_info", GW + "/rest/api/3/myself", GW + "/rest/api/3/myself"]);
  assert.equal(h.requests[1].headers.authorization, undefined);
  assert.deepEqual(h.routesSaved, [["gateway", "cloud-abc"]]);
  const stored = harness([myselfOk(GW)]);
  await stored.client.myself({ ...CREDS, route: "gateway", cloudId: "cloud-abc" });
  assert.deepEqual(stored.requests.map((r) => r.url), [GW + "/rest/api/3/myself"]);
});
await test("a 401 on the stored route repeats detection once, then reports 401", async () => {
  const h = harness([myself401(GW), myself401(SITE), tenantInfo]);
  const r = plain(await h.client.myself({ ...CREDS, route: "gateway", cloudId: "cloud-abc" }));
  assert.equal(r.ok, false); assert.equal(r.kind, "auth"); assert.equal(r.message, "Jira rejected the email or token.");
  assert.deepEqual(h.requests.map((q) => q.url), [GW + "/rest/api/3/myself", SITE + "/rest/api/3/myself", SITE + "/_edge/tenant_info", GW + "/rest/api/3/myself"]);
  const moved = harness([myself401(GW), myselfOk(SITE)]);
  assert.equal((await moved.client.myself({ ...CREDS, route: "gateway", cloudId: "cloud-abc" })).ok, true);
  assert.deepEqual(moved.routesSaved, [["site", ""]]);
});
await test("host allowlist: bad cloudId, foreign site and credential-bearing URLs never leave", async () => {
  const bad = harness([myself401(SITE), [at(SITE, "/_edge/tenant_info"), () => response(200, { cloudId: "../evil.test" })]]);
  assert.equal((await bad.client.myself(CREDS)).kind, "auth");
  assert.ok(bad.requests.every((r) => r.url.startsWith(SITE)));
  for (const site of ["https://evil.test", "http://acme.atlassian.net", "https://acme.atlassian.net.evil.test", "https://a.b.atlassian.net", ""]) {
    const h = harness([myselfOk(site)]);
    const r = plain(await h.client.myself({ ...CREDS, site }));
    assert.equal(r.kind, "config", site); assert.equal(h.requests.length, 0, site);
  }
});
await test("redirects are refused and never followed", async () => {
  const h = harness([[() => true, () => response(302, "", { location: "https://evil.test/steal" })]]);
  const r = plain(await h.client.myself({ ...CREDS, route: "site" }));
  assert.equal(r.kind, "redirect");
  assert.ok(h.requests.every((q) => !q.url.startsWith("https://evil.test")));
  const opaque = harness([[() => true, () => ({ ...response(0, ""), type: "opaqueredirect" })]]);
  assert.equal((await opaque.client.myself({ ...CREDS, route: "site" })).kind, "redirect");
});
await test("error mapping: 400 text, 403, 404, 5xx, network, timeout", async () => {
  const one = async (answer) => plain(await harness([[() => true, answer]]).client.search({ ...CREDS, route: "site" }, "project = X"));
  assert.deepEqual(await one(() => response(400, { errorMessages: ["The value 'X' does not exist for the field 'project'."], errors: { jql: "bad" } })),
    { ok: false, status: 400, kind: "badRequest", retry: false, message: "The value 'X' does not exist for the field 'project'. bad" });
  assert.equal((await one(() => response(403, {}))).kind, "forbidden");
  assert.equal((await one(() => response(404, {}))).message, "Not found, or you have no access.");
  const five = await one(() => response(503, "down"));
  assert.equal(five.kind, "unavailable"); assert.equal(five.retry, true); assert.equal(five.message, "Jira had a server error (HTTP 503).");
  const net = plain(await harness([], { fetch: async () => { throw new Error("socket hang up"); } }).client.myself({ ...CREDS, route: "site" }));
  assert.equal(net.message, "Could not reach Jira.");
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const slow = plain(await harness([], { fetch: hang, timeoutMs: 20 }).client.myself({ ...CREDS, route: "site" }));
  assert.equal(slow.kind, "unavailable"); assert.match(slow.message, /did not answer within/);
});
await test("429: waits Retry-After capped at 30 s, retries once, then reports busy", async () => {
  let n = 0;
  const h = harness([[() => true, () => (++n === 1 ? response(429, "", { "retry-after": "120" }) : response(200, { displayName: "Ada" }))]]);
  assert.equal((await h.client.myself({ ...CREDS, route: "site" })).ok, true);
  assert.deepEqual(h.sleeps, [30000]); assert.equal(n, 2);
  const busy = harness([[() => true, () => response(429, "", { "retry-after": "3" })]]);
  const r = plain(await busy.client.myself({ ...CREDS, route: "site" }));
  assert.equal(r.kind, "busy"); assert.equal(r.retry, true); assert.deepEqual(busy.sleeps, [3000]); assert.equal(busy.requests.length, 2);
});
await test("no secret in answers or logs; logs carry no query or JQL", async () => {
  const h = harness([[() => true, () => response(400, { errorMessages: [`bad ${EMAIL} ${TOKEN} ${BASIC}`] })]]);
  const r = plain(await h.client.search({ ...CREDS, route: "site" }, "summary ~ \"secret plan\""));
  const blob = JSON.stringify([r, h.logs]);
  for (const s of [EMAIL, TOKEN, BASIC, "secret plan"]) assert.ok(!blob.includes(s), s);
  assert.ok(h.logs.every((l) => /^(GET|POST) \S+ -> .+$/.test(l) && !l.includes("?")));
});
await test("queue: at most four requests in flight", async () => {
  let inFlight = 0, peak = 0;
  const fetch = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return response(200, { displayName: "Ada" }); };
  const h = harness([], { fetch });
  await Promise.all(Array.from({ length: 10 }, () => h.client.myself({ ...CREDS, route: "site" })));
  assert.equal(peak, 4);
});
await test("search body, records, projects, issue with comments", async () => {
  const h = harness([
    [at(SITE, "/rest/api/3/search/jql"), () => response(200, { issues: [ISSUE], nextPageToken: "tok-2" })],
    [at(SITE, "/rest/api/3/project/search"), () => response(200, { values: [{ key: "ACME", name: "Acme" }, { name: "no key" }] })],
    [at(SITE, "/rest/api/3/issue/ACME-7"), () => response(200, ISSUE)],
    [at(SITE, "/rest/api/3/issue/ACME-7/comment"), () => response(200, { comments: [{ author: { displayName: "Bo" }, created: "2026-11-02", body: { type: "doc", content: [] } }] })]
  ]);
  const c = { ...CREDS, route: "site" };
  const s = plain(await h.client.search(c, "assignee = currentUser()", "tok-1"));
  assert.deepEqual(h.requests[0].body, { jql: "assignee = currentUser()", fields: ["summary", "status", "assignee", "priority", "issuetype", "project", "updated", "subtasks"], maxResults: 50, nextPageToken: "tok-1" });
  assert.deepEqual(s.records[0], { key: "ACME-7", summary: "Fix rounding", status: "In Progress", statusId: "3", category: "inprogress", type: "Bug", priority: "High",
    assignee: "Ada", project: "ACME", updated: "2026-11-01T10:00:00.000+0000", labels: ["payroll"], subtasks: [], url: SITE + "/browse/ACME-7" });
  assert.equal(s.nextPageToken, "tok-2");
  assert.deepEqual(plain(await h.client.projects(c)), { ok: true, projects: [{ key: "ACME", name: "Acme" }] });
  const i = plain(await h.client.issue(c, "ACME-7"));
  assert.equal(new URL(h.requests[2].url).searchParams.get("fields"), "summary,status,assignee,priority,issuetype,project,description,updated,labels,reporter,fixVersions,parent,duedate,created,attachment,subtasks");
  assert.equal(new URL(h.requests[3].url).search, "?orderBy=-created&maxResults=5");
  assert.deepEqual(i.comments, [{ author: "Bo", created: "2026-11-02", body: { type: "doc", content: [] } }]);
  assert.deepEqual(i.description, { type: "doc", version: 1, content: [] });
});
await test("transitions: needsFields only for required fields without a default; fallback without expand", async () => {
  const list = { transitions: [
    { id: "11", name: "Start", to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } } },
    { id: "21", name: "Resolve", to: { id: "5", name: "Done", statusCategory: { key: "done" } }, fields: { resolution: { required: true, hasDefaultValue: false } } },
    { id: "31", name: "Close", to: { id: "6", name: "Closed", statusCategory: { key: "done" } }, fields: { resolution: { required: true, hasDefaultValue: true }, comment: { required: false } } }
  ] };
  const h = harness([[(u) => u.includes("/transitions?expand"), () => response(400, {})], [at(SITE, "/rest/api/3/issue/ACME-7/transitions"), () => response(200, list)]]);
  const r = plain(await h.client.transitions({ ...CREDS, route: "site" }, "ACME-7"));
  assert.deepEqual(r.transitions.map((t) => [t.id, t.toStatus, t.toCategory, t.needsFields]), [["11", "In Progress", "inprogress", false], ["21", "Done", "done", true], ["31", "Closed", "done", false]]);
  assert.equal(h.requests.length, 2);
  const post = harness([[(u, init) => init.method === "POST", () => response(204)], [at(SITE, "/rest/api/3/issue/ACME-7"), () => response(200, ISSUE)]]);
  const done = plain(await post.client.transition({ ...CREDS, route: "site" }, "ACME-7", "11"));
  assert.deepEqual(post.requests[0].body, { transition: { id: "11" } });
  assert.equal(done.record.status, "In Progress");
});
await test("issue details: reporter, fix versions, parent, due date, created and the comment total", async () => {
  const full = { key: "ACME-7", fields: { ...ISSUE.fields, reporter: { displayName: "Cy" }, fixVersions: [{ name: "1.2" }, { id: "9" }, { name: "2.0" }],
    parent: { key: "ACME-1", fields: { summary: "Payroll epic" } }, duedate: "2026-12-01", created: "2026-10-01T08:00:00.000+0000" } };
  const h = harness([
    [at(SITE, "/rest/api/3/issue/ACME-7"), () => response(200, full)],
    [at(SITE, "/rest/api/3/issue/ACME-7/comment"), () => response(200, { total: 9, comments: [{ author: { displayName: "Bo" }, created: "2026-11-02", body: null }] })],
    [at(SITE, "/rest/api/3/issue/ACME-8"), () => response(200, { key: "ACME-8", fields: { summary: "Bare", parent: { fields: {} } } })],
    [at(SITE, "/rest/api/3/issue/ACME-8/comment"), () => response(200, { comments: [] })]
  ]);
  const c = { ...CREDS, route: "site" };
  const i = plain(await h.client.issue(c, "ACME-7"));
  assert.equal(new URL(h.requests[0].url).searchParams.get("fields"), "summary,status,assignee,priority,issuetype,project,description,updated,labels,reporter,fixVersions,parent,duedate,created,attachment,subtasks");
  assert.deepEqual([i.record.reporter, i.record.fixVersions, i.record.parent, i.record.due, i.record.created],
    ["Cy", ["1.2", "2.0"], { key: "ACME-1", summary: "Payroll epic" }, "2026-12-01", "2026-10-01T08:00:00.000+0000"]);
  assert.equal(i.commentsTotal, 9);
  const bare = plain(await h.client.issue(c, "ACME-8"));
  assert.deepEqual([bare.record.reporter, bare.record.fixVersions, bare.record.parent, bare.record.due, bare.record.created], ["", [], null, "", ""], "empty fields map to empty values; a parent without a key is no parent");
  assert.equal(bare.commentsTotal, 0);
});
await test("sprintKeys: one key-only query for the page's keys; Jira errors pass through for the fallback", async () => {
  const h = harness([[at(SITE, "/rest/api/3/search/jql"), () => response(200, { issues: [{ key: "ACME-8" }, { key: 7 }, {}] })]]);
  const c = { ...CREDS, route: "site" };
  const r = plain(await h.client.sprintKeys(c, ["ACME-7", "ACME-8", "bad key) OR (x", "ACME-7"]));
  assert.deepEqual(h.requests[0].body, { jql: "key in (ACME-7, ACME-8) AND sprint in openSprints()", fields: ["key"], maxResults: 2 });
  assert.deepEqual(r, { ok: true, keys: ["ACME-8"] });
  assert.deepEqual(plain(await h.client.sprintKeys(c, [])), { ok: true, keys: [] });
  assert.equal(h.requests.length, 1, "no keys, no request");
  const no = harness([[at(SITE, "/rest/api/3/search/jql"), () => response(400, { errorMessages: ["Field 'sprint' does not exist or you do not have permission to view it."] })]]);
  const f = plain(await no.client.sprintKeys(c, ["ACME-7"]));
  assert.equal(f.ok, false); assert.equal(f.kind, "badRequest");
});
await test("agile: board lookup, backlog keys for the page, moves to backlog, board and sprint; refusals pass through", async () => {
  const h = harness([
    [(u) => u.split("?")[0] === SITE + "/rest/agile/1.0/board", () => response(200, { values: [{ id: 15, name: "B2 board", type: "simple" }, { id: "x" }, { id: 16, name: "Scrum", type: "scrum" }] })],
    [(u) => u.split("?")[0] === SITE + "/rest/agile/1.0/board/15/backlog", () => response(200, { issues: [{ key: "B2-2" }, { key: 3 }] })],
    [(u) => u.split("?")[0] === SITE + "/rest/agile/1.0/board/16/sprint", () => response(200, { values: [{ id: 77, state: "active" }] })],
    [(u, i) => i.method === "POST", () => response(204)]
  ]);
  const c = { ...CREDS, route: "site" };
  assert.deepEqual(plain(await h.client.boards(c, "B2")), { ok: true, boards: [{ id: 15, name: "B2 board", type: "simple" }, { id: 16, name: "Scrum", type: "scrum" }] });
  assert.equal(new URL(h.requests[0].url).search, "?projectKeyOrId=B2&maxResults=50");
  assert.deepEqual(plain(await h.client.backlogKeys(c, 15, ["B2-1", "B2-2", "evil) OR (1=1", "B2-1"])), { ok: true, keys: ["B2-2"] });
  const q = new URL(h.requests[1].url).searchParams;
  assert.deepEqual([q.get("jql"), q.get("fields"), q.get("maxResults")], ["key in (B2-1, B2-2)", "key", "2"]);
  assert.deepEqual(plain(await h.client.backlogKeys(c, 15, [])), { ok: true, keys: [] });
  assert.equal(h.requests.length, 2, "no keys, no request");
  assert.deepEqual(plain(await h.client.activeSprint(c, 16)), { ok: true, id: 77 });
  assert.equal(new URL(h.requests[2].url).search, "?state=active&maxResults=1");
  assert.equal((await h.client.moveToBacklog(c, { id: 15, type: "simple" }, "B2-1")).ok, true);
  assert.deepEqual([h.requests[3].url, h.requests[3].body], [SITE + "/rest/agile/1.0/backlog/15/issue", { issues: ["B2-1"] }], "the board-scoped backlog move: the unscoped one is a no-op on a board without sprints");
  assert.equal((await h.client.moveToBoard(c, { id: 15, type: "simple" }, "B2-1")).ok, true);
  assert.deepEqual([h.requests[4].url, h.requests[4].body], [SITE + "/rest/agile/1.0/board/15/issue", { issues: ["B2-1"] }]);
  assert.equal((await h.client.moveToBoard(c, { id: 16, type: "scrum" }, "B2-1", 77)).ok, true);
  assert.deepEqual([h.requests[5].url, h.requests[5].body], [SITE + "/rest/agile/1.0/sprint/77/issue", { issues: ["B2-1"] }]);
  assert.equal((await h.client.moveToBoard(c, { id: 16, type: "scrum" }, "B2-1")).ok, false, "Scrum without an active sprint id is refused before any request");
  assert.equal(h.requests.length, 6);
  for (const bad of ["b2-1", "B2-1 OR x"]) assert.equal((await h.client.moveToBacklog(c, { id: 15, type: "simple" }, bad)).ok, false);
  for (const bad of [null, { id: 0 }, { id: "15/../1" }]) assert.equal((await h.client.moveToBacklog(c, bad, "B2-1")).ok, false);
  for (const id of [0, -1, "15/../1", 1.5]) assert.equal((await h.client.backlogKeys(c, id, ["B2-1"])).ok, false, String(id));
  assert.equal(h.requests.length, 6, "bad keys and board ids never reach the network");
  const no = harness([[() => true, () => response(403, {})]]);
  const f = plain(await no.client.boards(c, "B2"));
  assert.equal(f.ok, false); assert.equal(f.status, 403); assert.equal(f.kind, "forbidden");
});
await test("attachments: metadata on the record, media mapped by rendered order, then filename, then position; no HTML leaves the client", async () => {
  const media = (id, alt, extra = {}) => ({ type: "mediaSingle", content: [{ type: "media", attrs: { id, type: "file", collection: "c", alt, ...extra } }] });
  const desc = { type: "doc", content: [media("m1", "image.png"), media("m2", "image.png"), media("m3", "spec.pdf"), media("m4", "x", { type: "external", url: "https://example.com/a.png" }), media("m5", "")] };
  const issue = { key: "ACME-7", fields: { ...ISSUE.fields, description: desc, attachment: [
    { id: "101", filename: "image.png", mimeType: "image/png", size: 2048, thumbnail: "https://acme.atlassian.net/thumb/101" },
    { id: "102", filename: "image.png", mimeType: "image/png", size: 4096 },
    { id: "103", filename: "spec.pdf", mimeType: "application/pdf", size: 9 },
    { id: "104", filename: "clip.mp4", mimeType: "video/mp4", size: 99 },
    { id: "bad", filename: "x" }, null] },
    renderedFields: { description: '<p><span class="image-wrap"><img src="/rest/api/3/attachment/content/102" onerror="alert(1)"></span><script>fetch("/rest/api/3/attachment/content/999")</script><img src="/secure/attachment/101/image.png"></p>' } };
  const h = harness([
    [at(SITE, "/rest/api/3/issue/ACME-7"), () => response(200, issue)],
    [at(SITE, "/rest/api/3/issue/ACME-7/comment"), () => response(200, { total: 1, comments: [{ author: { displayName: "Bo" }, created: "2026-11-02", body: { type: "doc", content: [media("c1", "clip.mp4"), media("c2", "nothing.txt")] } }] })]
  ]);
  const c = { ...CREDS, route: "site" };
  const i = plain(await h.client.issue(c, "ACME-7"));
  const u = new URL(h.requests[0].url);
  assert.equal(u.searchParams.get("expand"), "renderedFields");
  assert.ok(u.searchParams.get("fields").split(",").includes("attachment"));
  assert.deepEqual(i.record.attachments, [
    { id: "101", filename: "image.png", mimeType: "image/png", size: 2048, thumbnail: true },
    { id: "102", filename: "image.png", mimeType: "image/png", size: 4096, thumbnail: false },
    { id: "103", filename: "spec.pdf", mimeType: "application/pdf", size: 9, thumbnail: false },
    { id: "104", filename: "clip.mp4", mimeType: "video/mp4", size: 99, thumbnail: false }]);
  assert.deepEqual(i.mediaMap, { m1: "102", m2: "101", m3: "103", m5: "104", c1: "104" }, "rendered order first, then filename, then position; external media and unmatched comment media stay unpaired");
  assert.equal(JSON.stringify(i).includes("<"), false, "no rendered HTML reaches the page");
  const ids = load().__cdbJiraClientFactory.attachmentIds;
  assert.deepEqual(plain(ids('<a href="/rest/api/2/attachment/content/5"></a><img src=x onerror=1 data-x="/secure/attachment/6/a.png"><script>/rest/api/3/attachment/content/7</script>"/rest/api/3/attachment/content/5')), ["5", "6", "7"], "a strict id pattern: duplicates once, nothing executes");
  assert.deepEqual(plain(ids(null)), []);
});
await test("attachment bytes: ?redirect=false, size caps from the header and the body, redirects refused", async () => {
  const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const h = harness([
    [(u) => u.startsWith(SITE + "/rest/api/3/attachment/content/101"), () => response(200, png, { "content-type": "image/png", "content-length": "7" })],
    [(u) => u.startsWith(SITE + "/rest/api/3/attachment/thumbnail/101"), () => response(200, png, { "content-type": "image/png" })],
    [(u) => u.startsWith(SITE + "/rest/api/3/attachment/content/102"), () => response(200, png, { "content-length": "999999" })],
    [(u) => u.startsWith(SITE + "/rest/api/3/attachment/content/103"), () => response(200, Buffer.alloc(20))],
    [(u) => u.startsWith(SITE + "/rest/api/3/attachment/content/104"), () => response(302, "", { location: "https://api.media.atlassian.com/file/x" })]
  ]);
  const c = { ...CREDS, route: "site" };
  const r = await h.client.attachmentBytes(c, "101", false, 100);
  assert.equal(r.ok, true); assert.deepEqual([...r.bytes], [...png]); assert.equal(r.type, "image/png");
  assert.equal(new URL(h.requests[0].url).search, "?redirect=false");
  assert.equal((await h.client.attachmentBytes(c, "101", true, 100)).ok, true);
  assert.equal(new URL(h.requests[1].url).pathname + new URL(h.requests[1].url).search, "/rest/api/3/attachment/thumbnail/101?redirect=false");
  assert.equal((await h.client.attachmentBytes(c, "102", false, 100)).kind, "tooBig", "Content-Length over the cap");
  assert.equal((await h.client.attachmentBytes(c, "103", false, 10)).kind, "tooBig", "a body over the cap");
  const red = await h.client.attachmentBytes(c, "104", false, 100);
  assert.equal(red.ok, false); assert.equal(red.kind, "redirect");
  assert.equal(h.requests.filter((x) => x.url.includes("media.atlassian.com")).length, 0, "the redirect target is never fetched");
  assert.equal((await h.client.attachmentBytes(c, "../1", false, 100)).ok, false);
  assert.equal(h.requests.length, 5);
});
await test("agile 401 is a scope refusal: no route re-detection, and the refusal message is kept short and free of keys, emails and links", async () => {
  const msg = { code: 401, message: "Unauthorized; scope does not match B2-8863 for other@example.com see https://developer.atlassian.com/x " + "y".repeat(400) };
  const h = harness([[(u) => u.includes("/rest/agile/1.0/board/15/backlog"), () => response(401, msg)], [(u) => u.includes("/rest/agile/1.0/board?"), () => response(200, { values: [{ id: 15, name: "B", type: "simple" }] })]]);
  const c = { ...CREDS, route: "gateway", cloudId: "cloud-abc" };
  assert.equal((await h.client.boards(c, "B2")).ok, true);
  const r = plain(await h.client.backlogKeys(c, 15, ["B2-1"]));
  assert.equal(r.ok, false); assert.equal(r.status, 401);
  assert.equal(h.requests.length, 2, "no /myself, no tenant_info, no retry");
  assert.ok(r.detail.startsWith("Unauthorized; scope does not match <key> for <email> see <url>"), r.detail);
  assert.ok(r.detail.length <= 200);
  assert.equal(r.detail.includes(TOKEN), false);
  for (const call of [() => h.client.activeSprint(c, 15), () => h.client.moveToBacklog(c, { id: 15, type: "simple" }, "B2-1"), () => h.client.moveToBoard(c, { id: 15, type: "simple" }, "B2-1")]) {
    const n = h.requests.length; await call(); assert.ok(h.requests.slice(n).every((x) => x.url.includes("/rest/agile/")), "agile calls never re-detect");
  }
  const core = harness([[(u) => u.endsWith("/rest/api/3/myself"), () => response(401, {})]]);
  await core.client.myself({ ...CREDS, route: "site" });
  assert.ok(core.requests.length > 1, "core calls still re-detect after a 401");
});
await test("subtasks: mapped from the parent's subtasks field; their own list fields come from one key-only search", async () => {
  const parent = { key: "ACME-1", fields: { summary: "Parent", status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } }, subtasks: [
    { key: "ACME-2", fields: { summary: "Child one", status: { id: "1", name: "To Do", statusCategory: { key: "new" } }, issuetype: { name: "Sub-task" } } },
    { key: "bad key", fields: {} }, null,
    { key: "ACME-3", fields: { summary: "Child two", status: { id: "9", name: "Done", statusCategory: { key: "done" } }, issuetype: { name: "Sub-task" } } }] } };
  const h = harness([[at(SITE, "/rest/api/3/search/jql"), (u, init) => response(200, { issues: JSON.parse(init.body).jql.startsWith("key in") ? [{ key: "ACME-2", fields: { summary: "Child one", assignee: { displayName: "Bo" } } }] : [parent] })]]);
  const c = { ...CREDS, route: "site" };
  const s = plain(await h.client.search(c, "x = 1", ""));
  assert.deepEqual(s.records[0].subtasks, [{ key: "ACME-2", summary: "Child one", status: "To Do", statusId: "1", category: "todo", type: "Sub-task" },
    { key: "ACME-3", summary: "Child two", status: "Done", statusId: "9", category: "done", type: "Sub-task" }]);
  const ch = plain(await h.client.children(c, ["ACME-2", "ACME-3", "x) OR (1=1", "ACME-2"]));
  assert.deepEqual(h.requests[1].body, { jql: "key in (ACME-2, ACME-3) ORDER BY key ASC", fields: ["summary", "status", "assignee", "priority", "issuetype", "project", "updated", "subtasks"], maxResults: 2 });
  assert.equal(ch.ok, true); assert.equal(ch.records[0].assignee, "Bo");
  assert.deepEqual(plain(await h.client.children(c, [])), { ok: true, records: [] });
  assert.equal(h.requests.length, 2);
});
console.log(`PASS ${passed} Jira client tests`);
