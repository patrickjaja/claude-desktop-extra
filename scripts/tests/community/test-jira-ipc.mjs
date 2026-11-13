#!/usr/bin/env node
// Jira tracker: settings store, bridge, preload, claude.ai script and the IPC surface of js/jira_tracker_main.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOKEN = "jira-test-token-0123456789abcdef", EMAIL = "dev@example.com";
const plain = (x) => JSON.parse(JSON.stringify(x));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-jira-ipc-"));
const nodeRequire = createRequire(import.meta.url);
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("PASS " + name); };

function miniDom() {
  const compound = (s) => {
    const m = /^([a-z]*)/.exec(s), parts = { tag: m[1].toUpperCase(), cls: [], attrs: [] };
    const re = /\.([\w/-]+)|\[([\w-]+)(?:(\$?=)"?([^"\]]*)"?)?\]/g; let x;
    while ((x = re.exec(s.slice(m[1].length)))) { if (x[1]) parts.cls.push(x[1]); else parts.attrs.push([x[2], x[3], x[4]]); }
    return parts;
  };
  const hit = (el, c) => el.nodeType === 1 && (!c.tag || el.tagName === c.tag) &&
    c.cls.every((k) => (el.getAttribute("class") || "").split(/\s+/).includes(k)) &&
    c.attrs.every(([n, op, v]) => el.hasAttribute(n) && (!op || (op === "=" ? el.getAttribute(n) === v : el.getAttribute(n).endsWith(v))));
  const matchOne = (el, sel) => {
    const chain = sel.trim().split(/\s+/).map(compound);
    if (!hit(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2, n = el.parentNode;
    while (i >= 0 && n) { if (hit(n, chain[i])) i--; n = n.parentNode; }
    return i < 0;
  };
  const matches = (el, sel) => sel.split(",").some((s) => matchOne(el, s));
  class Text {
    constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; }
    get textContent() { return this.nodeValue; }
    cloneNode() { return new Text(this.nodeValue); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  }
  class El {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.childNodes = []; this.parentNode = null; this.listeners = {}; this.box = null; }
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
    setAttribute(n, v) { this.attrs.set(n, String(v)); }
    removeAttribute(n) { this.attrs.delete(n); }
    hasAttribute(n) { return this.attrs.has(n); }
    toggleAttribute(n, on) { if (on === undefined ? !this.attrs.has(n) : on) this.attrs.set(n, ""); else this.attrs.delete(n); return this.attrs.has(n); }
    get className() { return this.getAttribute("class") || ""; }
    set className(v) { this.setAttribute("class", v); }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
    set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (v !== "") this.appendChild(new Text(v)); }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { const s = this.parentNode && this.parentNode.childNodes; return s ? s[s.indexOf(this) + 1] || null : null; }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); c.parentNode = this; return c; }
    removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceWith(n) { this.parentNode.insertBefore(n, this); this.remove(); }
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
    matches(sel) { return matches(this, sel); }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
    all() { const out = []; const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 1) { out.push(c); walk(c); } }); walk(this); return out; }
    querySelectorAll(sel) { return this.all().filter((n) => matches(n, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    click() { const ev = { target: this, preventDefault() {}, stopPropagation() {} }; for (let n = this; n; n = n.parentNode) (n.listeners && n.listeners.click || []).forEach((f) => f(ev)); docClicks.forEach((f) => f(ev)); }
    getBoundingClientRect() { return this.box || { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    cloneNode(deep) { const c = new El(this.tagName); this.attrs.forEach((v, k) => c.attrs.set(k, v)); if (deep) this.childNodes.forEach((k) => c.appendChild(k.cloneNode(true))); return c; }
  }
  const docClicks = [], docOther = {};
  const html = new El("html");
  const document = {
    documentElement: html,
    querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s),
    createElement: (t) => new El(t), createElementNS: (_ns, t) => new El(t), createTextNode: (v) => new Text(v),
    createTreeWalker: (root) => { const list = []; const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 3) list.push(c); else walk(c); }); walk(root); let i = 0; return { nextNode: () => list[i++] || null }; },
    addEventListener: (t, f) => { if (t === "click") docClicks.push(f); else (docOther[t] = docOther[t] || []).push(f); }, removeEventListener: (t, f) => { docOther[t] = (docOther[t] || []).filter((g) => g !== f); },
    elementFromPoint: () => pointHit
  };
  let pointHit = null;
  const h = (tag, attrs = {}, ...kids) => { const e = new El(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); kids.forEach((k) => e.appendChild(typeof k === "string" ? new Text(k) : k)); return e; };
  const fire = (type, target) => (docOther[type] || []).forEach((f) => f({ type, target }));
  return { document, html, h, fire, pointAt: (n) => { pointHit = n; } };
}

function keyring(state = { available: true, backend: "gnome_libsecret" }) {
  return {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptString: (s) => Buffer.from("v1:" + [...s].reverse().join(""), "utf8"),
    decryptString: (b) => { const t = b.toString("utf8"); if (!t.startsWith("v1:")) throw new Error("bad"); return [...t.slice(3)].reverse().join(""); }
  };
}
function loadStore(dir, ks, platform = "linux") {
  fs.mkdirSync(dir, { recursive: true });
  const logs = [];
  const ctx = vm.createContext({ process: { platform }, Buffer, URL, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js/jira_tracker_store.js"), "utf8"), ctx);
  if (!ctx.__cdbJiraStoreFactory) return { store: null, logs };
  return { store: ctx.__cdbJiraStoreFactory({ fs, path, safeStorage: keyring(ks), userData: () => dir, log: (m) => logs.push(m) }), logs };
}

try {
  await test("switch: off by default, .json write keeps other keys, .jsonc locks", () => {
    const dir = path.join(temp, "pref");
    const { store } = loadStore(dir);
    assert.deepEqual(plain(store.prefRead()), { enabled: false, locked: false });
    fs.writeFileSync(path.join(dir, "claude-desktop-extra.json"), JSON.stringify({ themePicker: false }));
    assert.equal(store.prefWrite(true).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "claude-desktop-extra.json"), "utf8")), { themePicker: false, jiraTracker: true });
    assert.equal(store.prefWrite(false).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "claude-desktop-extra.json"), "utf8")), { themePicker: false });
    fs.writeFileSync(path.join(dir, "claude-desktop-extra.jsonc"), '{ // hand edited\n "jiraTracker": false, }');
    assert.deepEqual(plain(store.prefRead()), { enabled: false, locked: true });
    assert.equal(store.prefWrite(true).ok, false);
    fs.writeFileSync(path.join(dir, "claude-desktop-extra.jsonc"), "{}");
    fs.writeFileSync(path.join(dir, "claude-desktop-extra.json"), "{ broken");
    assert.match(store.prefWrite(true).error, /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(dir, "claude-desktop-extra.json"), "utf8"), "{ broken");
  });
  await test("credentials: site normalised, token encrypted in a 0600 file and never returned", () => {
    const dir = path.join(temp, "creds");
    const { store, logs } = loadStore(dir);
    for (const [input, out] of [["https://Acme.atlassian.net/jira/software/projects/A/boards/1?x=1", "https://acme.atlassian.net"], ["acme.atlassian.net", "https://acme.atlassian.net"], [" https://acme.atlassian.net/ ", "https://acme.atlassian.net"]]) {
      assert.equal(store.normaliseSite(input), out, input);
    }
    for (const bad of ["http://acme.atlassian.net", "https://acme.atlassian.net.evil.test", "https://evil.test", "https://user:pw@acme.atlassian.net", "https://acme.atlassian.net:8443", "https://a.b.atlassian.net", "javascript:alert(1)"]) {
      assert.equal(store.normaliseSite(bad), null, bad);
    }
    const r = store.credsSave({ site: "acme.atlassian.net", email: ` ${EMAIL} `, token: `  ${TOKEN}\n` });
    assert.equal(r.ok, true);
    const file = path.join(dir, "cdb-jira-credentials.json");
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes(TOKEN)); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["cloudId", "email", "route", "site", "tokenEnc"]);
    assert.deepEqual(plain(store.creds()), { site: "https://acme.atlassian.net", email: EMAIL, token: TOKEN, route: "", cloudId: "" });
    const view = plain(store.credsView());
    assert.deepEqual(view, { site: "https://acme.atlassian.net", email: EMAIL, tokenSet: true, keyringOk: true, keyringBackend: "gnome_libsecret" });
    assert.ok(!JSON.stringify(view).includes(JSON.parse(raw).tokenEnc));
    for (const bad of [null, "x", { site: "http://acme.atlassian.net" }, { email: "nope" }, { email: 5 }, { token: "short" }, { token: "has space in it" }, { token: 7 }]) {
      assert.equal(store.credsSave(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(plain(store.creds()).token, TOKEN, "a refused save changes nothing");
    assert.ok(!logs.join("\n").includes(TOKEN));
  });
  await test("a new site, email or token forgets the detected route", () => {
    const dir = path.join(temp, "route");
    const { store } = loadStore(dir);
    store.credsSave({ site: "acme.atlassian.net", email: EMAIL, token: TOKEN });
    store.saveRoute("gateway", "cloud-abc");
    assert.deepEqual([store.creds().route, store.creds().cloudId], ["gateway", "cloud-abc"]);
    store.credsSave({ email: EMAIL });
    assert.equal(store.creds().route, "gateway", "saving the same email keeps the route");
    store.credsSave({ site: "https://other.atlassian.net" });
    assert.deepEqual([store.creds().route, store.creds().cloudId], ["", ""]);
    store.saveRoute("site", "ignored");
    assert.deepEqual([store.creds().route, store.creds().cloudId], ["site", ""]);
    store.credsSave({ token: TOKEN + "x" });
    assert.equal(store.creds().route, "");
    store.credsSave({ token: null });
    assert.equal(store.creds(), null);
  });
  await test("keyring unavailable or basic_text: saving a token is refused", () => {
    for (const ks of [{ available: false, backend: "gnome_libsecret" }, { available: true, backend: "basic_text" }]) {
      const { store } = loadStore(path.join(temp, "k-" + ks.backend + ks.available), ks);
      const r = plain(store.credsSave({ site: "acme.atlassian.net", email: EMAIL, token: TOKEN }));
      assert.equal(r.ok, false); assert.match(r.error, /keyring/);
      assert.equal(store.credsView().keyringOk, false);
    }
  });
  await test("state: queries, last preset, project, folders and template are validated and persisted", () => {
    const dir = path.join(temp, "state");
    const { store } = loadStore(dir);
    assert.deepEqual(plain(store.state()), { queries: [], lastPreset: "assigned", project: "", sort: "updated", detailsOpen: true, boards: {}, folders: {}, template: "" });
    assert.equal(store.stateWrite({ board: { project: "B2", id: 15 } }).ok, true);
    assert.equal(store.stateWrite({ board: { project: "B2", id: 0 } }).ok, false);
    assert.equal(store.state().boards.B2, 15);
    assert.equal(store.stateWrite({ board: { project: "B2", id: null } }).ok, true, "null forgets the choice");
    assert.deepEqual(plain(store.state().boards), {});
    assert.equal(store.stateWrite({ detailsOpen: false }).ok, true);
    assert.equal(store.state().detailsOpen, false);
    assert.equal(store.stateWrite({ detailsOpen: "no" }).ok, false, "detailsOpen is a boolean");
    fs.writeFileSync(path.join(dir, "cdb-jira-state.json"), JSON.stringify({ detailsOpen: 0 }));
    assert.equal(store.state().detailsOpen, true, "a non-boolean stored value falls back to open");
    assert.equal(store.stateWrite({ sort: "priority" }).ok, true);
    assert.equal(store.state().sort, "priority");
    assert.equal(store.stateWrite({ sort: "ORDER BY x" }).ok, false, "only the four sort names");
    fs.writeFileSync(path.join(dir, "cdb-jira-state.json"), JSON.stringify({ sort: "bogus" }));
    assert.equal(store.state().sort, "updated", "an unknown stored sort falls back to updated");
    assert.equal(store.stateWrite({ saveQuery: { name: "Mine", jql: "assignee = currentUser()" } }).ok, true);
    assert.equal(store.stateWrite({ saveQuery: { name: "Mine", jql: "project = ACME" } }).ok, true);
    assert.deepEqual(plain(store.state().queries), [{ name: "Mine", jql: "project = ACME" }]);
    assert.equal(store.stateWrite({ saveQuery: { name: "x", jql: "y".repeat(2001) } }).ok, false);
    assert.equal(store.stateWrite({ saveQuery: { name: "bad\nname", jql: "x" } }).ok, false);
    assert.equal(store.stateWrite({ lastPreset: "reported", project: "ACME" }).ok, true);
    assert.equal(store.stateWrite({ lastPreset: "everything" }).ok, false);
    assert.equal(store.stateWrite({ folder: { project: "ACME", path: "/home/dev/acme" } }).ok, true);
    assert.equal(store.stateWrite({ folder: { project: "acme", path: "/x" } }).ok, false);
    assert.equal(store.stateWrite({ folder: { project: "ACME", path: "relative/x" } }).ok, false);
    assert.equal(store.stateWrite({ template: "Do {{key}}" }).ok, true);
    assert.equal(store.stateWrite({ template: "x".repeat(10001) }).ok, false);
    assert.equal(store.stateWrite({ deleteQuery: "Mine" }).ok, true);
    assert.deepEqual(plain(store.state()), { queries: [], lastPreset: "reported", project: "ACME", sort: "updated", detailsOpen: true, boards: {}, folders: { ACME: "/home/dev/acme" }, template: "Do {{key}}" });
    assert.equal(store.stateWrite({ template: null }).ok, true);
    assert.equal(store.state().template, "");
    assert.equal(fs.statSync(path.join(dir, "cdb-jira-state.json")).mode & 0o777, 0o600);
  });
  await test("win32 installs no store", () => {
    assert.equal(loadStore(path.join(temp, "win"), undefined, "win32").store, null);
  });
  await test("bridge: fixed jira channels, shaped arguments; preload: fixed methods", () => {
    const calls = []; let exposed = null;
    const listeners = {};
    const electron = { contextBridge: { exposeInMainWorld: (n, a) => { exposed = a; } }, ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); }, on: (ch, f) => { (listeners[ch] ||= []).push(f); } } };
    vm.runInNewContext(read("js/extra_settings_bridge.js"), vm.createContext({ console, require: (m) => { if (m !== "electron") throw new Error(m); return electron; } }));
    exposed.jiraOpen({ x: 1, y: 2, width: 3, height: 4, extra: 5 }); exposed.jiraClose(); exposed.jiraBounds("nope"); exposed.jiraPrefRead(); exposed.jiraPrefTest();
    exposed.jiraPrefSet({ enabled: true, site: "s", email: "e", token: null, template: null, other: 1 });
    assert.deepEqual(plain(calls), [["cdb-jira:open", { x: 1, y: 2, width: 3, height: 4 }], ["cdb-jira:close"], ["cdb-jira:bounds", { x: null, y: null, width: null, height: null }],
      ["cdb-jira-pref:read"], ["cdb-jira-pref:test"], ["cdb-jira-pref:set", { enabled: true, site: "s", email: "e", token: null, template: null }]]);
    assert.deepEqual(Object.keys(exposed).filter((k) => /^jira/.test(k)).sort(), ["jiraBounds", "jiraClose", "jiraOpen", "jiraPrefRead", "jiraPrefSet", "jiraPrefTest"]);
    calls.length = 0; exposed = null;
    vm.runInNewContext(read("js/jira_tracker_preload.js"), vm.createContext({ console, require: (m) => { if (m !== "electron") throw new Error(m); return electron; } }));
    assert.deepEqual(Object.keys(exposed).sort(), ["deleteQuery", "hide", "issue", "onTheme", "openExternal", "openIssue", "openSettings", "projects", "saveQuery", "search", "send", "setBoard", "setDetailsOpen", "state", "theme", "transition", "transitions", "move", "attachment", "download", "cover", "onCover", "drop", "children"].sort());
    exposed.search({ jql: "a", preset: "x" }, 5); exposed.search({ preset: "assigned", project: "ACME", extra: 1 }, "tok"); exposed.send("ACME-1");
    assert.deepEqual(plain(calls), [["cdb-jira:search", { jql: "a" }, ""], ["cdb-jira:search", { preset: "assigned", project: "ACME" }, "tok"], ["cdb-jira:send", { key: "ACME-1", action: "implement" }]]);
    exposed.onTheme("not a function");
    assert.equal((listeners["cdb-jira:theme"] || []).length, 0);
    const themes = [];
    exposed.onTheme((t) => themes.push(t));
    listeners["cdb-jira:theme"][0]({ sender: "main" }, { vars: { "--cds-page-bg": "#000" } });
    listeners["cdb-jira:theme"][0]({}, "junk");
    assert.deepEqual(plain(themes), [{ vars: { "--cds-page-bg": "#000" } }], "only theme objects reach the page");
    exposed.theme();
    assert.deepEqual(plain(calls.at(-1)), ["cdb-jira:theme"]);
    exposed.setDetailsOpen("yes");
    assert.deepEqual(plain(calls.at(-1)), ["cdb-jira:details", { open: true }]);
    exposed.move("B2-1", "board", "15");
    assert.deepEqual(plain(calls.at(-1)), ["cdb-jira:move", { key: "B2-1", to: "board", boardId: 15 }]);
    exposed.attachment("ACME-1", 101, "yes");
    assert.deepEqual(plain(calls.at(-1)), ["cdb-jira:attachment", { key: "ACME-1", id: "101", thumb: false }]);
    exposed.download("ACME-1", "101");
    assert.deepEqual(plain(calls.at(-1)), ["cdb-jira:download", { key: "ACME-1", id: "101" }]);
    exposed.children(["B2-1", 7]);
    assert.deepEqual(plain(calls.at(-1)), ["cdb-jira:children", { keys: ["B2-1", "7"] }]);
    exposed.drop("B2-1", ["3", 4, null], 12);
    assert.deepEqual(plain(calls.at(-1)), ["cdb-jira:drop", { key: "B2-1", statusIds: ["3", "4", ""], transitionId: "12" }]);
    exposed.setBoard("B2", 16);
    assert.deepEqual(plain(calls.at(-1)), ["cdb-jira:board", { project: "B2", boardId: 16 }]);
  });
  await test("web script: no bridge installs nothing; missing anchors fall back to the whole view and warn once", async () => {
    const run = (win) => vm.runInNewContext(read("js/jira_tracker_web_page.js"), vm.createContext(win));
    assert.equal(run({ window: {} , document: {} }), "jira: no bridge");
    const calls = [], diag = [], listeners = {};
    const window = { innerWidth: 1000, innerHeight: 700, addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: (n) => { delete listeners[n]; },
      cdbExtra: { jiraOpen: async (r) => { calls.push(["open", r]); return { ok: true }; }, jiraClose: async () => { calls.push(["close"]); return { ok: true }; },
        jiraBounds: async (r) => { calls.push(["bounds", r]); return { ok: true }; }, diag: async (m) => { diag.push(m); return { ok: true }; } } };
    const document = { documentElement: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} };
    class MutationObserver { observe() {} disconnect() {} }
    const timers = [];
    const ctx = vm.createContext({ window, document, MutationObserver, ResizeObserver: class { observe() {} disconnect() {} }, console: { warn: () => {} },
      setTimeout: (f) => { timers.push(f); return timers.length; }, requestAnimationFrame: (f) => f() });
    assert.equal(vm.runInContext(read("js/jira_tracker_web_page.js"), ctx), "jira: installed");
    const api = window.__cdbJiraWeb;
    assert.deepEqual(plain(api.rect()), { x: 0, y: 0, width: 1000, height: 700 });
    assert.equal(api.open(), true);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(plain(calls[0]), ["open", { x: 0, y: 0, width: 1000, height: 700 }]);
    for (let i = 0; i < 40; i++) { api.refresh(); timers.splice(0).forEach((f) => f()); }
    assert.equal(diag.filter((m) => m.startsWith("[cdb-jira] anchor:sidebar")).length, 1);
    assert.equal(diag.filter((m) => m.startsWith("[cdb-jira] anchor:content")).length, 1);
    assert.equal(vm.runInContext(read("js/jira_tracker_web_page.js"), ctx), "jira: refreshed");
    api.remove();
    assert.equal(window.__cdbJiraWeb, undefined);

    const ROW = "w-full shrink-0 border-none";
    const sidebarOf = (h, ...kids) => { const s = h("aside", { "data-testid": "sidebar" }, h("div", { class: "dframe-nav-scroll" }, ...kids)); s.box = { x: 0, y: 35.99, top: 35.99, left: 0, right: 279.17, bottom: 1200, width: 279.17, height: 1164.01 }; return s; };
    const control = (h) => h("div", { class: "absolute end-2" }, h("button", { class: "cds-reset group/btn relative", "aria-label": "More" }, h("svg")));
    const hitRow = (h, b) => h("div", { class: "group hit-row" }, b, control(h));
    const install = (dom, opts = {}) => {
      const calls = [], diag = [], winEvents = {}, observers = [];
      const win = { innerWidth: 1000, innerHeight: 700, addEventListener: (n, f) => { (winEvents[n] ||= []).push(f); }, removeEventListener: () => {},
        cdbExtra: { jiraOpen: async (r) => { calls.push(["open", r]); return { ok: true }; }, jiraClose: async () => { calls.push(["close"]); return { ok: true }; },
          jiraBounds: async (r) => { calls.push(["bounds", r]); return { ok: true }; }, diag: async (m) => { diag.push(m); return { ok: true }; } } };
      const timers = [];
      const MO = class { constructor(f) { this.f = f; this.targets = []; observers.push(this); } observe(t, o) { this.targets.push([t, o]); } disconnect() { this.targets = []; } };
      const c = vm.createContext({ window: win, document: dom.document, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: MO,
        ResizeObserver: class { observe() {} disconnect() {} }, console: { warn: () => {} }, setTimeout: (f) => { timers.push(f); return timers.length; },
        requestAnimationFrame: opts.frozenFrames ? () => 0 : (f) => f() });
      assert.equal(vm.runInContext(read("js/jira_tracker_web_page.js"), c), "jira: installed");
      const scans = (n) => { for (let i = 0; i < n; i++) { win.__cdbJiraWeb.refresh(); timers.splice(0).forEach((f) => f()); } };
      return { win, calls, diag, scans, winEvents, observers, timers };
    };
    const strip = (n) => n.all().concat([n]);
    {
      const dom = miniDom(), { h } = dom;
      const sch = h("button", { class: ROW }, h("svg"), "Scheduled");
      const side = sidebarOf(h, h("div", { class: "list" }, hitRow(h, h("button", { class: ROW }, "Artifacts")), hitRow(h, sch)));
      const shell = h("div", { class: "shell" }, side);
      dom.html.appendChild(shell);
      dom.pointAt(sch);
      const { win, calls, winEvents, observers, timers } = install(dom, { frozenFrames: true });
      const tick = () => new Promise((r) => setTimeout(r, 5));
      win.__cdbJiraWeb.open(); await tick();
      assert.equal(calls[0][0], "open");
      win.innerWidth = 1400;
      (winEvents.resize || []).forEach((f) => f());
      timers.splice(0).forEach((f) => f()); await tick();
      assert.deepEqual(plain(calls.at(-1)), ["bounds", { x: 279, y: 36, width: 1121, height: 664 }], "a window resize re-measures even when the claude.ai view paints no frame");
      const watched = observers.flatMap((o) => o.targets.filter(([, opt]) => opt && opt.attributes).map(([t]) => [o, t]));
      assert.ok(watched.some(([, t]) => t === side) && watched.some(([, t]) => t === shell), "the sidebar and its parents are watched for attribute changes");
      dom.pointAt(h("div", { class: "dframe-pane-scroller" }));
      const n = calls.length;
      watched.find(([, t]) => t === shell)[0].f([{ type: "attributes", target: shell }]);
      timers.splice(0).forEach((f) => f()); await tick();
      assert.equal(calls.length, n + 1);
      assert.deepEqual(plain(calls.at(-1)), ["bounds", { x: 0, y: 36, width: 1400, height: 664 }], "a class change on the sidebar's parent (collapse) re-measures");
      assert.equal(typeof win.__cdbJiraWeb.stats, "object");
    }
    {
      const dom = miniDom(), { h } = dom;
      const scheduled = h("button", { class: ROW, id: "sch", "aria-pressed": "true", "data-state": "active" }, h("svg"), h("span", {}, "Scheduled"));
      const artifacts = h("button", { class: ROW }, h("svg"), "Artifacts");
      const list = h("div", { class: "list" }, hitRow(h, h("button", { class: "hit-row-main flex h-full", "aria-current": "page" }, "New", h("kbd", {}, "Ctrl+N"))),
        h("div", { class: "shrink-0" }, h("button", { class: ROW }, "Search")), hitRow(h, artifacts), hitRow(h, scheduled), h("div", { class: "-mt-1" }, h("button", { class: ROW }, "Design"), h("button", { class: ROW }, "Customize")));
      const recents = h("div", { class: "recents" }, hitRow(h, h("button", { class: ROW }, "Scheduled")));
      const side = sidebarOf(h, list, recents);
      dom.html.appendChild(side);
      dom.pointAt(scheduled);
      const { win, calls } = install(dom);
      const rows = dom.document.querySelectorAll("[data-cdb-jira-row]");
      assert.equal(rows.length, 1, "per-row wrappers: one Jira row");
      const row = rows[0];
      assert.equal(row.getAttribute("class"), "group hit-row");
      assert.equal(list.childNodes.indexOf(row), list.childNodes.indexOf(scheduled.parentNode) + 1, "the Jira row follows the nav Scheduled row, not the recents one");
      const btn = row.querySelector("button");
      assert.equal(btn.textContent, "Jira");
      assert.equal(row.querySelectorAll("button").length, 1, "the 24x24 control is not cloned");
      for (const n of strip(row)) for (const a of ["id", "aria-pressed", "data-state", "aria-selected", "aria-current"]) assert.equal(n.hasAttribute(a), false, a);
      assert.deepEqual(plain(win.__cdbJiraWeb.rect()), { x: 279, y: 36, width: 721, height: 664 });
      btn.click();
      await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(plain(calls[0]), ["open", { x: 279, y: 36, width: 721, height: 664 }]);
      assert.equal(btn.getAttribute("aria-current"), "page");
      assert.ok(btn.getAttribute("class").split(" ").includes("cdb-jira-row-active"));
      assert.equal(row.hasAttribute("data-cdb-jira-active"), true);
      dom.pointAt(h("div", { class: "dframe-pane-scroller" }));
      dom.fire("transitionend", scheduled);
      await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(plain(calls[1]), ["bounds", { x: 0, y: 36, width: 1000, height: 664 }], "a sidebar transition re-measures; a collapsed sidebar gives the full width");
      dom.fire("animationend", h("div"));
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(calls.length, 2, "an animation outside the sidebar does not re-measure");
      scheduled.click();
      await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(plain(calls[2]), ["close"]);
      assert.equal(btn.hasAttribute("aria-current"), false);
      assert.equal(btn.getAttribute("class").split(" ").includes("cdb-jira-row-active"), false);
    }
    {
      const dom = miniDom(), { h } = dom;
      const scheduled = h("button", { class: ROW, "aria-current": "page" }, h("svg"), "Scheduled");
      const shared = h("div", { class: "-mt-1" }, scheduled, h("button", { class: ROW }, "On-call"), h("button", { class: ROW }, "Customize"));
      dom.html.appendChild(sidebarOf(h, h("div", { class: "list" }, hitRow(h, h("button", { class: ROW }, "Artifacts")), shared)));
      dom.pointAt(scheduled);
      install(dom);
      const row = dom.document.querySelector("[data-cdb-jira-row]");
      assert.ok(row && row.tagName === "BUTTON", "list-wide wrapper: the clone is the button itself");
      assert.equal(shared.childNodes.indexOf(row), shared.childNodes.indexOf(scheduled) + 1);
      assert.equal(row.hasAttribute("aria-current"), false, "upstream's active marker is not copied");
      assert.equal(row.textContent, "Jira");
    }
    {
      const dom = miniDom(), { h } = dom;
      const artifacts = h("button", { class: ROW }, h("svg"), "Artifacts", h("button", { class: "cds-reset", "aria-label": "New from a template" }));
      const list = h("div", { class: "list" }, h("button", { class: ROW }, "New"), artifacts, h("button", { class: ROW }, "On-call"));
      dom.html.appendChild(sidebarOf(h, list));
      install(dom);
      const row = dom.document.querySelector("[data-cdb-jira-row]");
      assert.ok(row && row.tagName === "BUTTON", "bare buttons: the clone is the button itself");
      assert.equal(list.childNodes.indexOf(row), list.childNodes.indexOf(artifacts) + 1, "without Scheduled the Jira row follows Artifacts");
      assert.equal(row.querySelectorAll("button").length, 0);
      assert.equal(row.textContent, "Jira");
    }
    {
      const dom = miniDom(), { h } = dom;
      const zw = "​";
      const glyph = (c) => h("span", { class: "icon-box" }, c);
      const scheduled = h("button", { class: ROW }, glyph(""), h("span", {}, zw, "Sched­uled", zw));
      const control = (c, label) => h("button", { class: "cds-reset", "aria-label": label }, c);
      const shared = h("div", { class: "-mt-1" }, scheduled, h("button", { class: ROW }, glyph(""), "On-call"), control("", "More"));
      const contentLink = h("a", { href: "/artifacts" }, "Artifacts");
      dom.html.appendChild(sidebarOf(h, h("div", { class: "list" }, h("div", { class: "group hit-row" }, h("button", { class: ROW }, glyph(""), "Artifacts"), control("", "New from a template")), shared)));
      dom.html.appendChild(h("main", {}, contentLink));
      dom.pointAt(scheduled);
      const { diag } = install(dom);
      const row = dom.document.querySelector("[data-cdb-jira-row]");
      assert.ok(row, "1P labels (icon-font glyph, zero-width characters, soft hyphen) still match");
      assert.equal(contentLink.nextSibling, null, "a content link to /artifacts outside the sidebar never gets the row");
      assert.equal(shared.childNodes.indexOf(row), shared.childNodes.indexOf(scheduled) + 1, "the row follows Scheduled; glyph-only controls do not count as rows");
      assert.equal(row.tagName, "BUTTON");
      const box = row.querySelector(".icon-box");
      assert.ok(box && box.querySelector("svg"), "the glyph's own box now holds our svg");
      assert.equal(box.childNodes.length, 1, "the glyph box holds only our svg");
      assert.equal(/[-]/.test(row.textContent), false, "no glyph left in the clone");
      assert.equal(row.textContent.replace(/[​­]/g, ""), "Jira");
      assert.equal(box.querySelector("svg").getAttribute("aria-hidden"), "true");
      assert.equal(box.querySelector("svg").getAttribute("width"), "1em");
      assert.equal(diag.length, 0);
    }
    {
      const dom = miniDom(), { h } = dom;
      const scheduled = h("button", { class: ROW }, "Scheduled");
      const list = h("div", { class: "list" }, h("button", { class: ROW }, "NewCtrl+N"), scheduled, h("button", { class: "cds-reset", "aria-label": "More" }, ""));
      dom.html.appendChild(sidebarOf(h, list));
      install(dom);
      const row = dom.document.querySelector("[data-cdb-jira-row]");
      assert.ok(row, "glyph and label in one text node still match");
      assert.equal(list.childNodes.indexOf(row), list.childNodes.indexOf(scheduled) + 1);
      assert.equal(row.childNodes[0].tagName, "SVG", "the svg takes the glyph's place before the label");
      assert.equal(row.textContent, "Jira");
    }
    {
      const dom = miniDom(), { h } = dom;
      const plain = h("button", { class: ROW }, "Scheduled");
      dom.html.appendChild(sidebarOf(h, h("div", { class: "list" }, h("button", { class: ROW }, "New"), plain)));
      install(dom);
      const row = dom.document.querySelector("[data-cdb-jira-row]");
      assert.ok(row.querySelector("svg"), "a model with neither svg nor glyph still gets our icon");
      assert.equal(row.textContent, "Jira");
    }
    {
      const dom = miniDom(), { h } = dom;
      dom.html.appendChild(sidebarOf(h, h("div", {}, h("button", { class: ROW }, "Neu"), h("button", { class: ROW }, "Geplant"))));
      const { diag, scans } = install(dom);
      scans(40);
      assert.equal(dom.document.querySelector("[data-cdb-jira-row]"), null, "unknown labels: no row");
      assert.equal(diag.filter((m) => m.startsWith("[cdb-jira] anchor:row-text")).length, 1);
      assert.equal(diag.filter((m) => m.startsWith("[cdb-jira] anchor:sidebar")).length, 0);
    }
  });
  const MODULES = ["js/jira_tracker_adf.js", "js/jira_tracker_client.js", "js/jira_tracker_store.js", "js/jira_tracker_prompt.js", "js/jira_tracker_send.js", "js/jira_tracker_view.js"];
  function mainSource() {
    const subs = { "__CDB_JIRA_PAGE_HTML__": read("js/jira_tracker_page.html"), "__CDB_JIRA_PAGE_JS__": read("js/jira_tracker_page.js"),
      "__CDB_JIRA_ADF_SRC__": read("js/jira_tracker_adf.js"), "__CDB_JIRA_PRELOAD__": read("js/jira_tracker_preload.js"), "__CDB_JIRA_WEB_SRC__": read("js/jira_tracker_web_page.js") };
    let src = read("js/jira_tracker_main.js");
    for (const [k, v] of Object.entries(subs)) { assert.equal(src.split(`"${k}"`).length, 2, k); src = src.split(`"${k}"`).join(JSON.stringify(v)); }
    return src;
  }
  class FakeWC {
    constructor(id, url) { Object.assign(this, { id, url, destroyed: false, zoom: 1, events: {}, js: [], css: [], cssRemoved: [], focused: 0, loaded: null, openHandler: null }); }
    insertCSS(css) { this.css.push(css); return Promise.resolve("css-" + this.css.length); }
    removeInsertedCSS(key) { this.cssRemoved.push(key); return Promise.resolve(); }
    send(ch, data) { (this.sent ||= []).push([ch, plain(data)]); }
    isDestroyed() { return this.destroyed; } getURL() { return this.url; } getZoomFactor() { return this.zoom; } focus() { this.focused++; } isFocused() { return !!this.hasFocus; }
    setZoomFactor(z) { this.zoom = z; } getZoomLevel() { return Math.log(this.zoom) / Math.log(1.2); } setZoomLevel(l) { this.zoom = Math.pow(1.2, l); }
    on(n, f) { (this.events[n] ||= []).push(f); return this; } emit(n, ...a) { (this.events[n] || []).forEach((f) => f(...a)); }
    executeJavaScript(code) { this.js.push(code); return Promise.resolve(this.jsResult === undefined ? true : this.jsResult); }
    loadFile(p) { this.loaded = p; return Promise.resolve(); } setWindowOpenHandler(f) { this.openHandler = f; } close() { this.destroyed = true; }
  }
  function world(dir, opts = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const handlers = {}, appEvents = {}, views = [], shellOpened = [], fetches = [], bodies = [];
    const all = [];
    const app = { getPath: () => dir, on: (n, f) => { (appEvents[n] ||= []).push(f); }, whenReady: () => Promise.resolve() };
    const emitApp = (n, ...a) => (appEvents[n] || []).forEach((f) => f(...a));
    const wc = (id, url) => { const w = new FakeWC(id, url); all.push(w); emitApp("web-contents-created", {}, w); return w; };
    class WebContentsView {
      constructor(o) { this.opts = o; this.bounds = null; this.visible = true; views.push(this); this.webContents = wc(1000 + views.length, "file://" + dir + "/cdb-jira-tracker/tracker.html"); }
      setBounds(b) { this.bounds = b; } getBounds() { return this.bounds; } setVisible(v) { this.visible = v; }
    }
    const kids = (list) => ({ children: list, addChildView(v) { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); list.push(v); }, removeChildView(v) { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); } });
    const electron = {
      app, WebContentsView, safeStorage: keyring(), dialog: {}, Notification: { isSupported: () => false },
      shell: { openExternal: async (u) => { shellOpened.push(u); }, showItemInFolder: (p) => { shellOpened.push("folder:" + p); } },
      ipcMain: { handle: (ch, f) => { handlers[ch] = f; }, removeHandler: (ch) => { delete handlers[ch]; } },
      webContents: { getAllWebContents: () => all.filter((w) => !w.destroyed) },
      BrowserWindow: { getAllWindows: () => windows }
    };
    const windows = [];
    const ctx = vm.createContext({ require: (m) => (m === "electron" ? electron : nodeRequire(m)), process: { platform: opts.platform || "linux" }, Buffer, URL, AbortController,
      setTimeout: opts.setTimeout || setTimeout, clearTimeout, console, fetch: async (u, i) => { fetches.push(u); bodies.push(i && i.body ? String(i.body) : ""); const a = opts.respond ? opts.respond(u, i && i.body ? JSON.parse(i.body) : null) : null;
        const bin = a && Buffer.isBuffer(a[1]) ? a[1] : null, hdr = (a && a[2]) || {};
        return { status: a ? a[0] : 200, ok: a ? a[0] < 300 : true, headers: { get: (k) => (k in hdr ? String(hdr[k]) : null) }, text: async () => (a ? JSON.stringify(a[1]) : '{"displayName":"Ada"}'),
          arrayBuffer: async () => { const b = bin || Buffer.from(a ? JSON.stringify(a[1]) : ""); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } }; } });
    vm.runInContext(read("js/sender_guard.js"), ctx);
    for (const f of MODULES) vm.runInContext(read(f), ctx);
    vm.runInContext(mainSource(), ctx);
    const claude = wc(2, "https://claude.ai/new");
    claude.zoom = opts.zoom || 1;
    const emitter = (o) => Object.assign(o, { ev: {}, on(n, f) { (this.ev[n] ||= []).push(f); return this; }, removeListener(n, f) { this.ev[n] = (this.ev[n] || []).filter((x) => x !== f); return this; },
      emit(n, ...a) { (this.ev[n] || []).forEach((f) => f(...a)); } });
    const claudeView = emitter({ webContents: claude, box: { x: 0, y: 30, width: 1200, height: 800 } });
    claudeView.getBounds = () => ({ ...claudeView.box });
    const win = emitter({ webContents: wc(1, "about:blank"), contentView: kids([claudeView]), isDestroyed: () => false, hasFocus: true, focusCalls: 0 });
    win.isFocused = () => win.hasFocus; win.focus = () => { win.focusCalls++; win.hasFocus = true; };
    const popout = wc(3, "https://claude.ai/epitaxy/local_1");
    windows.push(win, { webContents: popout, contentView: kids([]), isDestroyed: () => false });
    const ev = (sender, parent = null) => ({ sender, senderFrame: { parent } });
    const call = async (ch, sender, ...a) => plain(await handlers[ch](ev(sender), ...a));
    return { ctx, handlers, call, ev, claude, claudeView, popout, win, views, shellOpened, fetches, bodies, emitApp, all, wc, dir };
  }
  const RECT = { x: 260, y: 0, width: 940, height: 800 };
  const on = (w) => w.call("cdb-jira-pref:set", w.claude, { enabled: true });

  await test("win32: no handler is registered", () => {
    const w = world(path.join(temp, "w-win"), { platform: "win32" });
    assert.deepEqual(Object.keys(w.handlers), []);
  });
  await test("switch off: claude.ai and tracker channels refused, settings work, Test makes no network call", async () => {
    const w = world(path.join(temp, "w-off"));
    assert.match((await w.call("cdb-jira:open", w.claude, RECT)).error, /switched off/);
    assert.equal((await w.call("cdb-jira-pref:read", w.claude)).enabled, false);
    assert.equal((await w.call("cdb-jira-pref:set", w.claude, { site: "acme.atlassian.net", email: EMAIL, token: TOKEN })).ok, true);
    assert.equal((await w.call("cdb-jira-pref:test", w.claude)).ok, false);
    assert.equal(w.fetches.length, 0);
    assert.equal(w.views.length, 0);
  });
  const scopeWorld = (name, answers) => world(path.join(temp, name), { respond: (u, b) => {
    const p = new URL(u).pathname;
    for (const [suffix, a] of answers) if (p.endsWith(suffix)) return typeof a === "function" ? a(u, b) : a;
    return null;
  } });
  const testRun = async (w) => {
    await on(w);
    await w.call("cdb-jira-pref:set", w.claude, { site: "https://acme.atlassian.net", email: EMAIL, token: TOKEN });
    const stateFile = path.join(w.dir, "cdb-jira-state.json"), before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
    const diags = []; w.ctx.__cdbDiag = (m) => diags.push(m);
    const n0 = w.fetches.length, r = await w.call("cdb-jira-pref:test", w.claude);
    assert.equal(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null, before, "Test connection writes no page state");
    const log = diags.join("\n");
    for (const secret of ["currentUser", "ORDER BY", "Ada", EMAIL, TOKEN, "B2-1"]) assert.ok(!log.includes(secret), "no " + secret + " in the log");
    return { r, sent: w.fetches.slice(n0) };
  };
  await test("Test connection: one check per feature, at most 4 extra requests (5 on a Scrum board), no state written, nothing private logged", async () => {
    for (const type of ["simple", "scrum"]) {
      const w = scopeWorld("w-scopes-" + type, [
        ["/rest/api/3/myself", [200, { displayName: "Ada" }]],
        ["/rest/api/3/search/jql", [200, { issues: [{ key: "B2-1", fields: { project: { key: "B2" } } }] }]],
        ["/rest/agile/1.0/board", [200, { values: [{ id: 15, name: "B2 board", type }] }]],
        ["/board/15/backlog", [401, { message: "Unauthorized; scope does not match" }]],
        ["/board/15/configuration", [200, { columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1" }] }] } }]],
        ["/board/15/sprint", [401, { message: "Unauthorized; scope does not match" }]]]);
      const { r, sent } = await testRun(w);
      assert.equal(r.ok, true); assert.equal(r.displayName, "Ada"); assert.equal(r.token, "classic");
      assert.deepEqual(r.checks.map((c) => [c.feature, c.state]), [["Tickets", "ok"], ["Board and Backlog", "failed"], ["Board view columns", "ok"]].concat(type === "scrum" ? [["Scrum sprints", "failed"]] : []));
      assert.match(r.checks[1].text, /^Probably missing read:board-scope:jira-software, read:issue-details:jira \(inferred/);
      assert.equal(sent.filter((u) => !u.endsWith("/myself")).length, type === "scrum" ? 5 : 4, "extra requests after the auth check (route detection is part of the auth check)");
      const search = JSON.parse(w.bodies[w.fetches.indexOf(sent.find((u) => u.includes("/search/jql")))]);
      assert.deepEqual(search, { jql: "assignee = currentUser() ORDER BY updated DESC", fields: ["project"], maxResults: 50 });
      assert.ok(sent.some((u) => u.includes("projectKeyOrId=B2")));
    }
  });
  await test("Test connection: the page's last project, a board without a backlog, no project with a board, and a scoped token", async () => {
    let w = scopeWorld("w-scopes-last", [
      ["/rest/api/3/myself", [200, { displayName: "Ada" }]],
      ["/rest/api/3/search/jql", [200, { issues: [{ key: "XY-3", fields: { project: { key: "XY" } } }] }]],
      ["/rest/agile/1.0/board", [200, { values: [{ id: 30, name: "XY board", type: "kanban" }] }]],
      ["/board/30/backlog", [400, { errorMessages: ["The board does not support the backlog"] }]],
      ["/board/30/configuration", [200, { columnConfig: { columns: [] } }]]]);
    fs.mkdirSync(w.dir, { recursive: true });
    fs.writeFileSync(path.join(w.dir, "cdb-jira-state.json"), JSON.stringify({ project: "XY" }));
    let { r, sent } = await testRun(w);
    assert.equal(JSON.parse(w.bodies[w.fetches.indexOf(sent.find((u) => u.includes("/search/jql")))]).jql, "project = XY ORDER BY updated DESC");
    assert.deepEqual(r.checks.map((c) => c.text), ["OK", "Not checked: this board has no backlog", "OK"]);
    w = scopeWorld("w-scopes-none", [["/rest/api/3/myself", [200, { displayName: "Ada" }]], ["/rest/api/3/search/jql", [200, { issues: [] }]]]);
    ({ r, sent } = await testRun(w));
    assert.deepEqual(r.checks.map((c) => c.text), ["OK", "Not checked: no project with a board", "Not checked: no project with a board"]);
    assert.equal(sent.filter((u) => !u.endsWith("/myself")).length, 1, "only the search when no project is known");
    w = scopeWorld("w-scopes-gw", [
      ["/_edge/tenant_info", [200, { cloudId: "cloud-abc" }]],
      ["/rest/api/3/myself", (u) => (u.startsWith("https://api.atlassian.com/") ? [200, { displayName: "Ada" }] : [401, {}])],
      ["/rest/api/3/search/jql", [401, { message: "Unauthorized; scope does not match" }]]]);
    ({ r, sent } = await testRun(w));
    assert.equal(r.token, "scoped");
    assert.deepEqual(r.checks.map((c) => [c.feature, c.state]), [["Tickets", "failed"], ["Board and Backlog", "not-checked"], ["Board view columns", "not-checked"]]);
    const searchAt = sent.findIndex((u) => u.includes("/search/jql"));
    assert.ok(searchAt > 0 && !sent.slice(searchAt).some((u) => u.endsWith("/myself") || u.endsWith("/tenant_info")), "a refused check does not re-detect the route");
  });
  await test("pref:read carries the scope groups for the card", async () => {
    const w = world(path.join(temp, "w-scopes-read"));
    const r = await w.call("cdb-jira-pref:read", w.claude);
    assert.deepEqual(r.scopes.map((g) => g.name), ["Basic", "Board and Backlog", "Scrum boards only, untested"]);
  });
  await test("sender groups: the main window's claude.ai view only for open/close/bounds; the tracker view only for data", async () => {
    const w = world(path.join(temp, "w-senders"));
    await on(w);
    const foreign = w.wc(9, "https://evil.test/");
    for (const s of [w.popout, foreign]) assert.match((await w.call("cdb-jira:open", s, RECT)).error, /unrecognized sender/);
    assert.match(plain(await w.handlers["cdb-jira:open"](w.ev(w.claude, {}), RECT)).error, /unrecognized sender/, "subframe");
    assert.equal((await w.call("cdb-jira-pref:read", foreign)).ok, false);
    assert.match((await w.call("cdb-jira:search", w.claude, { preset: "assigned" })).error, /unrecognized sender/);
    assert.equal((await w.call("cdb-jira:open", w.claude, RECT)).ok, true);
    const tracker = w.views[0].webContents;
    assert.equal((await w.call("cdb-jira:state", tracker)).ok, true);
    assert.match((await w.call("cdb-jira:open", tracker, RECT)).error, /unrecognized sender/);
    w.claude.jsResult = { vars: { "--cds-page-bg": "#101010", "--cds-text-primary": "rgb(1, 2, 3)", "--cds-evil": "url(https://x.test/a.png)", "--cds-semi": "red;}",
      "--cds-long": "a".repeat(201), "--cds-bs": "\\61", "--cds-lt": "<b>", "--cds-ex": "EXPRESSION(1)", "--notcds": "#fff", "--cds-bad name": "#000" },
      scheme: "dark", font: "Inter, sans-serif", bg: "rgb(16, 16, 16)", fg: "expression(alert(1))" };
    const pulled = await w.call("cdb-jira:theme", tracker);
    assert.deepEqual(pulled.theme, { vars: { "--cds-page-bg": "#101010", "--cds-text-primary": "rgb(1, 2, 3)" }, scheme: "dark", font: "Inter, sans-serif", bg: "rgb(16, 16, 16)", fg: "" },
      "theme values: only --cds-* names, at most 200 characters, no url( expression( ; { } \\ < >");
    assert.ok(w.claude.js.some((c) => c.includes("getComputedStyle")), "the theme is read in the claude.ai view");
    assert.match((await w.call("cdb-jira:theme", w.claude)).error, /unrecognized sender/, "the claude.ai view cannot pull the theme");
    const tick = () => new Promise((r) => setTimeout(r, 5));
    w.claude.jsResult = { vars: { "--cds-page-bg": "#202020" }, scheme: "light", font: "", bg: "", fg: "" };
    tracker.emit("focus"); await tick();
    assert.deepEqual(tracker.sent.filter((x) => x[0] === "cdb-jira:theme"), [["cdb-jira:theme", { vars: { "--cds-page-bg": "#202020" }, scheme: "light", font: "", bg: "", fg: "" }]], "a changed theme is pushed to the tracker on focus");
    tracker.emit("focus"); await tick();
    assert.equal(tracker.sent.filter((x) => x[0] === "cdb-jira:theme").length, 1, "an identical theme is not pushed again");
    for (const other of [w.claude, w.popout]) assert.equal((other.sent || []).length, 0, "the theme goes to the tracker only");
    const many = {}; for (let i = 0; i < 2001; i++) many["--cds-t" + i] = "1px";
    w.claude.jsResult = { vars: many, scheme: "", font: "", bg: "", fg: "" };
    assert.equal(Object.keys((await w.call("cdb-jira:theme", tracker)).theme.vars).length, 2000, "at most 2000 names");
    const big = {}; for (let i = 0; i < 1000; i++) big["--cds-b" + i] = "x".repeat(190);
    w.claude.jsResult = { vars: big, scheme: "", font: "", bg: "", fg: "" };
    assert.ok(JSON.stringify((await w.call("cdb-jira:theme", tracker)).theme).length <= 131072 + 200, "at most 128 KB of theme values");
  });
  await test("theme: a change while the page is open reaches it, also without focus or an OS scheme change", async () => {
    const polls = [];
    const w = world(path.join(temp, "w-theme-watch"), { setTimeout: (f, ms) => { if (ms === 1000) { polls.push(f); return polls.length; } return setTimeout(f, ms); } });
    await on(w);
    w.claude.jsResult = { vars: { "--cds-page-bg": "#ffffff" }, scheme: "light", font: "", bg: "rgb(255, 255, 255)", fg: "" };
    assert.equal((await w.call("cdb-jira:open", w.claude, RECT)).ok, true);
    const tracker = w.views[0].webContents, tick = () => new Promise((r) => setTimeout(r, 5));
    await tick();
    const pushed = () => tracker.sent.filter((x) => x[0] === "cdb-jira:theme").map((x) => x[1].bg);
    assert.deepEqual(pushed(), ["rgb(255, 255, 255)"]);
    w.claude.jsResult = { vars: { "--cds-page-bg": "#fdf6e3" }, scheme: "light", font: "", bg: "rgb(253, 246, 227)", fg: "" };
    assert.equal(polls.length, 1, "one theme check is scheduled while the page is open");
    polls.shift()(); await tick();
    assert.deepEqual(pushed(), ["rgb(255, 255, 255)", "rgb(253, 246, 227)"], "a theme applied while the page is open is pushed");
    assert.equal(polls.length, 1, "the check repeats");
    polls.shift()(); await tick();
    assert.equal(pushed().length, 2, "an unchanged theme is not pushed again");
    w.claude.jsResult = { vars: { "--cds-page-bg": "#eff1f5" }, scheme: "light", font: "", bg: "rgb(239, 241, 245)", fg: "" };
    polls.shift()(); await tick();
    assert.deepEqual(pushed(), ["rgb(255, 255, 255)", "rgb(253, 246, 227)", "rgb(239, 241, 245)"], "a second light-to-light switch is pushed too");
    assert.equal((await w.call("cdb-jira:hide", tracker)).ok, true);
    while (polls.length) { polls.shift()(); await tick(); }
    assert.equal(polls.length, 0, "the checks stop once the page is closed");
  });
  await test("input checks: key, JQL length, transition id, action, rectangle, page token, link scheme", async () => {
    const w = world(path.join(temp, "w-input"));
    await on(w);
    for (const r of [null, { x: -1, y: 0, width: 1, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }, { x: "1", y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: Infinity, height: 1 }]) {
      assert.equal((await w.call("cdb-jira:open", w.claude, r)).ok, false, JSON.stringify(r));
    }
    await w.call("cdb-jira:open", w.claude, RECT);
    const t = w.views[0].webContents;
    for (const key of ["acme-1", "ACME", "ACME-1 OR 1=1", "A-1", 7]) assert.equal((await w.call("cdb-jira:issue", t, { key })).error, "bad issue key", String(key));
    assert.equal((await w.call("cdb-jira:search", t, { jql: "x".repeat(2001) })).error, "bad query");
    assert.equal((await w.call("cdb-jira:search", t, { preset: "everything" })).error, "bad query");
    assert.equal((await w.call("cdb-jira:search", t, { preset: "assigned", project: "acme" })).error, "bad query");
    assert.equal((await w.call("cdb-jira:search", t, { preset: "assigned" }, "bad token with spaces")).error, "bad page token");
    assert.equal((await w.call("cdb-jira:transition", t, { key: "ACME-1", id: "11 OR 1" })).error, "bad transition");
    assert.equal((await w.call("cdb-jira:send", t, { key: "ACME-1", action: "deploy" })).error, "bad send request");
    assert.equal((await w.call("cdb-jira:open-external", t, { url: "javascript:alert(1)" })).error, "bad link");
    assert.equal((await w.call("cdb-jira:open-external", t, { url: "https://example.com/x" })).ok, true);
    assert.deepEqual(w.shellOpened, ["https://example.com/x"]);
    assert.equal((await w.call("cdb-jira:search", t, { preset: "assigned" })).kind, "config");
    assert.equal((await w.call("cdb-jira-pref:set", w.claude, { site: "https://acme.atlassian.net", email: EMAIL, token: TOKEN })).ok, true);
    const jqlOf = async (q) => { w.bodies.length = 0; await w.call("cdb-jira:search", t, q); const b = w.bodies.filter((x) => x.indexOf('"jql"') >= 0).pop(); return b ? JSON.parse(b).jql : null; };
    assert.equal((await w.call("cdb-jira:search", t, { preset: "assigned", sort: "ORDER BY x" })).error, "bad query", "sort is one of four names");
    assert.equal(await jqlOf({ preset: "assigned", project: "", sort: "priority" }), "assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC");
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, "cdb-jira-state.json"), "utf8")).sort, "priority", "the chosen sort is remembered");
    assert.equal(await jqlOf({ preset: "reported", project: "ACME" }), "project = ACME AND reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC");
    assert.equal(await jqlOf({ jql: "project = ACME ORDER BY rank" }), "project = ACME ORDER BY rank", "free JQL keeps its own ORDER BY without a chosen sort");
    assert.equal(await jqlOf({ jql: "project = ACME ORDER BY rank", sort: "key" }), "project = ACME ORDER BY key ASC", "a chosen sort replaces it");
  });
  await test("groups: without the Agile API, sprint keys mark Board rows; a failed sprint query falls back to categories; one diag line each", async () => {
    const issue = (key) => ({ key, fields: { summary: key, project: { key: "ACME" }, status: { id: "1", name: "To Do", statusCategory: { key: "new" } } } });
    let sprintStatus = 200;
    const w = world(path.join(temp, "w-groups"), { respond: (u, b) => {
      if (u.includes("/rest/agile/")) return [403, {}];
      if (!b || !b.jql) return null;
      if (/openSprints/.test(b.jql)) return sprintStatus === 200 ? [200, { issues: [{ key: "ACME-2" }] }] : [400, { errorMessages: ["Field 'sprint' does not exist"] }];
      return [200, { issues: [issue("ACME-1"), issue("ACME-2")] }];
    } });
    const diags = []; w.ctx.__cdbDiag = (m) => diags.push(m);
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    const t = w.views[0].webContents;
    assert.equal((await w.call("cdb-jira-pref:set", w.claude, { site: "https://acme.atlassian.net", email: EMAIL, token: TOKEN })).ok, true);
    const r = await w.call("cdb-jira:search", t, { preset: "assigned" });
    assert.equal(r.groups, "sprint");
    assert.equal(r.agileNotice, true);
    assert.deepEqual(r.records.map((x) => [x.key, x.sprint, x.place]), [["ACME-1", false, undefined], ["ACME-2", true, undefined]]);
    assert.equal(JSON.parse(w.bodies.filter((x) => /openSprints/.test(x)).pop()).jql, "key in (ACME-1, ACME-2) AND sprint in openSprints()");
    sprintStatus = 400;
    const f = await w.call("cdb-jira:search", t, { preset: "assigned" });
    assert.equal(f.ok, true);
    assert.equal(f.groups, "category");
    assert.equal(f.records.length, 2);
    await w.call("cdb-jira:search", t, { preset: "assigned" });
    assert.deepEqual(diags.filter((m) => /groups:/.test(m)), ["[cdb-jira] groups: agile unavailable 403", "[cdb-jira] groups: sprint unavailable"], "one diag line each, no ticket text");
    assert.equal(w.fetches.filter((u) => u.includes("/rest/agile/1.0/board?")).length, 1, "a refused board lookup is not repeated in this run");
  });
  await test("agile: a refused backlog read is cached per board, never re-detects the route, and its reason is logged once", async () => {
    const issue = (key) => ({ key, fields: { summary: key, project: { key: "B2" }, status: { id: "1", name: "S", statusCategory: { key: "new" } } } });
    const w = world(path.join(temp, "w-agile401"), { respond: (u, b) => {
      const p = new URL(u).pathname;
      if (p.endsWith("/rest/agile/1.0/board")) return [200, { values: [{ id: 15, name: "B2 board", type: "simple" }] }];
      if (p.endsWith("/board/15/backlog")) return [401, { code: 401, message: "Unauthorized; scope does not match" }];
      if (b && b.jql) return [200, { issues: [issue("B2-1")] }];
      return null;
    } });
    const diags = []; w.ctx.__cdbDiag = (m) => diags.push(m);
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    const t = w.views[0].webContents;
    await w.call("cdb-jira-pref:set", w.claude, { site: "https://acme.atlassian.net", email: EMAIL, token: TOKEN });
    assert.equal((await w.call("cdb-jira:search", t, { preset: "assigned" })).agileNotice, true);
    const n = w.fetches.length;
    for (let i = 0; i < 3; i++) assert.equal((await w.call("cdb-jira:search", t, { preset: "assigned" })).agileNotice, true);
    const later = w.fetches.slice(n);
    assert.equal(later.filter((u) => u.includes("/backlog")).length, 0, "the refusal is cached for the board");
    assert.equal(later.filter((u) => u.endsWith("/myself")).length, 0, "no route re-detection from agile calls");
    assert.deepEqual(diags.filter((m) => /groups: agile/.test(m)), ["[cdb-jira] groups: agile unavailable 401 Unauthorized; scope does not match"]);
  });
  await test("agile: Board = page rows not in the board's backlog; moves re-read the place; the board choice is kept per project", async () => {
    const issue = (key, project, cat = "new") => ({ key, fields: { summary: key, project: { key: project }, issuetype: { name: key === "B2-2" ? "Story" : "Bug" }, status: { id: "1", name: "S", statusCategory: { key: cat } } } });
    const backlog = { 15: ["B2-2"], 16: [], 30: ["XY-1"] };
    let configReads = 0, statusReads = 0, moveNoop = false, stale = 0, snapshot = [];
    const delays = [], VERIFY = [400, 800, 1600, 3200], verifyDelays = () => delays.splice(0).filter((ms) => VERIFY.includes(ms));
    const w = world(path.join(temp, "w-agile"), { setTimeout: (f, ms) => { delays.push(ms); return setTimeout(f, 0); }, respond: (u, b) => {
      const url = new URL(u), p = url.pathname;
      if (p.endsWith("/rest/agile/1.0/board")) return [200, { values: url.searchParams.get("projectKeyOrId") === "B2" ? [{ id: 15, name: "B2 board", type: "simple" }, { id: 16, name: "B2 scrum", type: "scrum" }] : [{ id: 30, name: "XY", type: "kanban" }] }];
      const m = p.match(/\/board\/(\d+)\/backlog$/);
      if (m) { const keys = /key in \(([^)]*)\)/.exec(url.searchParams.get("jql"))[1].split(", "); const list = m[1] === "15" && stale > 0 && stale-- ? snapshot : backlog[m[1]]; return [200, { issues: list.filter((k) => keys.includes(k)).map((key) => ({ key })) }]; }
      if (/\/board\/16\/sprint$/.test(p)) return [200, { values: [] }];
      if (p.endsWith("/board/15/configuration")) { configReads++; return [200, { columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1" }] }, { name: "Doing", statuses: [{ id: "3" }, { id: "4" }] }] } }]; }
      if (p.endsWith("/configuration")) return [404, { errorMessages: ["no"] }];
      if (p.endsWith("/project/B2/statuses")) { statusReads++; return [200, [{ name: "Bug", statuses: [{ id: "1", name: "To Do", statusCategory: { key: "new" } }, { id: "3", name: "Doing", statusCategory: { key: "indeterminate" } }] },
        { name: "Epic", statuses: [{ id: "7", name: "Epic only", statusCategory: { key: "new" } }] }, { name: "Story", statuses: [{ id: "9", name: "Done", statusCategory: { key: "done" } }, { id: "1", name: "To Do", statusCategory: { key: "new" } }] }]]; }
      if (p.endsWith("/project/XY/statuses")) return [403, {}];
      if (p.endsWith("/issue/B2-1/transitions")) return [200, { transitions: [{ id: "11", name: "Start", to: { id: "3", name: "Doing" } }, { id: "12", name: "Uphill", to: { id: "4", name: "Uphill" } }] }];
      if (p.endsWith("/issue/B2-2/transitions")) return [200, { transitions: [{ id: "11", name: "Start", to: { id: "3", name: "Doing" } }] }];
      if (b && b.transition) return [204, ""];
      if (p.endsWith("/rest/agile/1.0/backlog/issue")) return [204, ""];
      if (p.endsWith("/rest/agile/1.0/backlog/15/issue")) { if (moveNoop) return [204, ""]; b.issues.forEach((k) => { if (!backlog[15].includes(k)) backlog[15].push(k); }); return [204, ""]; }
      if (p.endsWith("/rest/agile/1.0/board/15/issue")) { backlog[15] = backlog[15].filter((k) => !b.issues.includes(k)); return [204, ""]; }
      if (b && b.jql) return [200, { issues: [issue("B2-1", "B2"), issue("B2-2", "B2"), issue("B2-3", "B2", "done"), issue("XY-1", "XY")] }];
      return null;
    } });
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    const t = w.views[0].webContents;
    await w.call("cdb-jira-pref:set", w.claude, { site: "https://acme.atlassian.net", email: EMAIL, token: TOKEN });
    let r = await w.call("cdb-jira:search", t, { preset: "assigned" });
    assert.equal(r.groups, "agile");
    assert.equal(r.agileNotice, undefined);
    assert.deepEqual(r.records.map((x) => [x.key, x.place, x.boardId]), [["B2-1", "board", 15], ["B2-2", "backlog", 15], ["B2-3", "board", 15], ["XY-1", "backlog", 30]]);
    assert.deepEqual(r.boards.B2, { current: { id: 15, name: "B2 board", type: "simple" }, all: [{ id: 15, name: "B2 board", type: "simple" }, { id: 16, name: "B2 scrum", type: "scrum" }], noSprint: false,
      columns: [{ name: "To Do", statusIds: ["1"] }, { name: "Doing", statusIds: ["3", "4"] }] });
    assert.equal(r.boards.XY.columns, undefined, "a refused configuration leaves the per-status fallback");
    assert.deepEqual(r.statusColumns.B2, [{ name: "To Do", statusIds: ["1"] }, { name: "Doing", statusIds: ["3"] }, { name: "Done", statusIds: ["9"] }], "the statuses of the issue types on the page (Bug, Story; not Epic), by category then name");
    assert.equal(r.statusColumns.XY, undefined, "a refused status read leaves the columns from the cards");
    const before = w.fetches.length;
    await w.call("cdb-jira:search", t, { preset: "assigned" });
    assert.equal(w.fetches.slice(before).filter((u) => u.includes("/rest/agile/1.0/board?")).length, 0, "board lookups are cached for the run");
    assert.equal(configReads, 1, "the board configuration is cached too");
    assert.equal(statusReads, 1, "project statuses are cached too");
    const kids = await w.call("cdb-jira:children", t, { keys: ["B2-1", "B2-2"] });
    assert.equal(kids.ok, true);
    assert.equal(JSON.parse(w.bodies.filter((x) => /key in \(B2-1, B2-2\) ORDER BY key ASC/.test(x)).pop()).maxResults, 2);
    for (const a of [{ keys: [] }, { keys: ["b2-1"] }, { keys: "B2-1" }, { keys: Array.from({ length: 51 }, (_, i) => "B2-" + (i + 1)) }, null]) assert.equal((await w.call("cdb-jira:children", t, a)).error, "bad subtask keys", JSON.stringify(a).slice(0, 40));
    assert.match((await w.call("cdb-jira:children", w.claude, { keys: ["B2-1"] })).error, /unrecognized sender/);
    const ch = await w.call("cdb-jira:drop", t, { key: "B2-1", statusIds: ["3", "4"], transitionId: "" });
    assert.equal(ch.kind, "choose"); assert.deepEqual(ch.options.map((o) => o.id), ["11", "12"]);
    const dn = await w.call("cdb-jira:drop", t, { key: "B2-2", statusIds: ["3", "4"], transitionId: "" });
    assert.equal(dn.kind, "done");
    for (const a of [{ key: "B2-1", statusIds: [], transitionId: "" }, { key: "B2-1", statusIds: ["3"], transitionId: "x" }, { key: "b2-1", statusIds: ["3"], transitionId: "" }, { key: "B2-1", statusIds: "3", transitionId: "" }, null])
      assert.equal((await w.call("cdb-jira:drop", t, a)).error, "bad drop", JSON.stringify(a));
    assert.match((await w.call("cdb-jira:drop", w.claude, { key: "B2-1", statusIds: ["3"], transitionId: "" })).error, /unrecognized sender/);
    snapshot = backlog[15].slice(); stale = 2; verifyDelays();
    const m1 = await w.call("cdb-jira:move", t, { key: "B2-1", to: "backlog", boardId: 15 });
    assert.deepEqual(m1, { ok: true, place: "backlog" }, "a backlog read that lags the move is read again");
    assert.deepEqual(verifyDelays(), [400, 800], "two stale reads: retried after 400 ms, then 800 ms");
    snapshot = backlog[15].slice(); stale = 1;
    const m2 = await w.call("cdb-jira:move", t, { key: "B2-1", to: "board", boardId: 15 });
    assert.deepEqual(m2, { ok: true, place: "board" }, "the move back is verified the same way");
    assert.deepEqual(verifyDelays(), [400]);
    moveNoop = true;
    const m3 = await w.call("cdb-jira:move", t, { key: "B2-1", to: "backlog", boardId: 15 });
    moveNoop = false;
    assert.deepEqual(m3, { ok: false, place: "board", message: "Jira accepted the move but the ticket did not move." }, "a 204 that changed nothing is a failure, not a pending row");
    assert.deepEqual(verifyDelays(), VERIFY, "it gives up only after the last retry, about 6 s");
    assert.equal((await w.call("cdb-jira:move", t, { key: "B2-1", to: "board", boardId: 99 })).ok, false, "a board that is not the project's is refused");
    for (const a of [{ key: "B2-1", to: "sprint", boardId: 15 }, { key: "b2-1", to: "board", boardId: 15 }, { key: "B2-1", to: "board", boardId: "15" }, null]) assert.equal((await w.call("cdb-jira:move", t, a)).error, "bad move");
    assert.equal((await w.call("cdb-jira:board", t, { project: "B2", boardId: 16 })).ok, true);
    assert.equal((await w.call("cdb-jira:board", t, { project: "b2", boardId: 16 })).error, "bad board choice");
    r = await w.call("cdb-jira:search", t, { preset: "assigned" });
    assert.deepEqual(r.boards.B2.current, { id: 16, name: "B2 scrum", type: "scrum" });
    assert.equal(r.boards.B2.noSprint, true);
    assert.deepEqual(r.records.filter((x) => x.project === "B2").map((x) => x.place), ["board", "board", "board"], "nothing in board 16's backlog");
    const sm = await w.call("cdb-jira:move", t, { key: "B2-1", to: "board", boardId: 16 });
    assert.equal(sm.ok, false); assert.match(sm.message, /No active sprint/);
    assert.equal((await w.call("cdb-jira:state", t)).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, "cdb-jira-state.json"), "utf8")).boards.B2, 16);
    assert.match((await w.call("cdb-jira:move", w.claude, { key: "B2-1", to: "board", boardId: 15 })).error, /unrecognized sender/);
  });
  await test("attachments: bytes only for the open ticket's files, inline types and caps, a 50 MB cache, Save to Downloads with a safe unique name", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10]);
    const files = [{ id: "101", filename: "shot.png", mimeType: "image/png", size: 6, thumbnail: "t" }, { id: "102", filename: "logo.svg", mimeType: "image/svg+xml", size: 9 },
      { id: "103", filename: "big.png", mimeType: "image/png", size: 11 * 1048576 }, { id: "104", filename: "clip.webm", mimeType: "video/webm", size: 40 * 1048576 },
      { id: "105", filename: "../../etc/pa ss<w>d.txt", mimeType: "text/plain", size: 3 }, { id: "106", filename: "moved.png", mimeType: "image/png", size: 3 }];
    const w = world(path.join(temp, "w-media"), { respond: (u) => {
      const p = new URL(u).pathname;
      if (p.endsWith("/issue/ACME-7")) return [200, { key: "ACME-7", fields: { summary: "S", attachment: files } }];
      if (p.endsWith("/issue/ACME-8")) return [200, { key: "ACME-8", fields: { summary: "T", attachment: [] } }];
      if (/\/comment$/.test(p)) return [200, { comments: [] }];
      if (/\/attachment\/(content|thumbnail)\/10[1-5]$/.test(p)) return [200, png, { "content-type": "image/png" }];
      if (p.endsWith("/attachment/content/106")) return [302, ""];
      return null;
    } });
    const diags = []; w.ctx.__cdbDiag = (m) => diags.push(m);
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    const t = w.views[0].webContents;
    await w.call("cdb-jira-pref:set", w.claude, { site: "https://acme.atlassian.net", email: EMAIL, token: TOKEN });
    assert.match((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "101" })).error, /not an attachment of the open ticket/, "nothing before the ticket is read");
    await w.call("cdb-jira:issue", t, { key: "ACME-7" });
    const before = w.fetches.length;
    const raw = await w.handlers["cdb-jira:attachment"](w.ev(t), { key: "ACME-7", id: "101" });
    assert.equal(raw.ok, true); assert.equal(raw.mime, "image/png");
    assert.ok(ArrayBuffer.isView(raw.bytes) && raw.bytes.constructor.name === "Uint8Array", "bytes, not base64");
    assert.deepEqual([...raw.bytes], [...png]);
    assert.ok(w.fetches.slice(before).some((u) => u.endsWith("/attachment/content/101?redirect=false")));
    const n = w.fetches.length;
    assert.equal((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "101" })).ok, true);
    assert.equal(w.fetches.length, n, "the second read comes from the cache");
    assert.equal((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "101", thumb: true })).ok, true);
    assert.ok(w.fetches.at(-1).endsWith("/attachment/thumbnail/101?redirect=false"));
    assert.match((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "102" })).error, /not shown inline/, "svg is a chip");
    assert.match((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "103" })).error, /too large/, "images up to 10 MB");
    assert.equal((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "104" })).ok, true, "videos up to 50 MB");
    assert.match((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "999" })).error, /not an attachment of the open ticket/);
    assert.match((await w.call("cdb-jira:attachment", t, { key: "ACME-9", id: "101" })).error, /not an attachment of the open ticket/);
    for (const a of [{ key: "ACME-7", id: "1/../2" }, { key: "x", id: "101" }, null]) assert.equal((await w.call("cdb-jira:attachment", t, a)).error, "bad attachment");
    assert.equal((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "106" })).ok, false);
    assert.deepEqual(diags.filter((m) => /media:/.test(m)), ["[cdb-jira] media: redirect refused"]);
    const s1 = await w.call("cdb-jira:download", t, { key: "ACME-7", id: "105" });
    const s2 = await w.call("cdb-jira:download", t, { key: "ACME-7", id: "105" });
    assert.deepEqual([s1.ok, s1.name, s2.name], [true, "pa ss_w_d.txt", "pa ss_w_d (1).txt"], "base name only, unsafe characters replaced, never overwritten");
    assert.equal(fs.readFileSync(path.join(w.dir, "pa ss_w_d.txt")).length, png.length);
    assert.ok(w.shellOpened.includes("folder:" + path.join(w.dir, "pa ss_w_d (1).txt")));
    assert.ok(!diags.join("\n").includes("pa ss"), "file names stay out of the log");
    assert.match((await w.call("cdb-jira:download", t, { key: "ACME-7", id: "999" })).error, /not an attachment of the open ticket/);
    await w.call("cdb-jira:issue", t, { key: "ACME-8" });
    assert.match((await w.call("cdb-jira:attachment", t, { key: "ACME-7", id: "101" })).error, /not an attachment of the open ticket/, "only the ticket read last");
    assert.match((await w.call("cdb-jira:attachment", w.claude, { key: "ACME-8", id: "101" })).error, /unrecognized sender/);
  });
  await test("details card state: read with the state, written through its own channel", async () => {
    const w = world(path.join(temp, "w-details"));
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    const t = w.views[0].webContents;
    assert.equal((await w.call("cdb-jira:state", t)).detailsOpen, true);
    assert.equal((await w.call("cdb-jira:details", t, { open: false })).ok, true);
    assert.equal((await w.call("cdb-jira:state", t)).detailsOpen, false);
    assert.equal((await w.call("cdb-jira:details", t, { open: "x" })).error, "bad details state");
    assert.match((await w.call("cdb-jira:details", w.claude, { open: true })).error, /unrecognized sender/);
  });
  await test("view: sandboxed, written page carries the CSP hash of its one inline script, navigation and popups denied", async () => {
    const dir = path.join(temp, "w-view");
    const w = world(dir);
    await on(w);
    assert.equal((await w.call("cdb-jira:open", w.claude, RECT)).ok, true);
    const v = w.views[0];
    assert.deepEqual(plain(v.opts.webPreferences), { preload: path.join(dir, "cdb-jira-tracker/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false });
    assert.equal(v.webContents.loaded, path.join(dir, "cdb-jira-tracker/tracker.html"));
    const html = fs.readFileSync(v.webContents.loaded, "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 1);
    const hash = crypto.createHash("sha256").update(scripts[0], "utf8").digest("base64");
    assert.ok(html.includes(`script-src 'sha256-${hash}'`));
    assert.ok(!/<\/script/i.test(scripts[0]));
    assert.ok(html.includes("default-src 'none'"));
    assert.equal(fs.readFileSync(path.join(dir, "cdb-jira-tracker/preload.js"), "utf8"), read("js/jira_tracker_preload.js"));
    assert.deepEqual(plain(v.webContents.openHandler()), { action: "deny" });
    let prevented = 0;
    v.webContents.emit("will-navigate", { preventDefault: () => prevented++ });
    assert.equal(prevented, 1);
    assert.equal(w.win.contentView.children.at(-1), v, "added above the claude.ai view");
    assert.ok(v.webContents.focused > 0);
  });
  await test("bounds: rectangle x zoom with upstream rounding, offset by the claude.ai view, clamped", async () => {
    const w = world(path.join(temp, "w-bounds"), { zoom: 1.25 });
    await on(w);
    await w.call("cdb-jira:open", w.claude, { x: 260.3, y: 0.4, width: 600, height: 640 });
    assert.deepEqual(plain(w.views[0].bounds), { x: 326, y: 31, width: 749, height: 799 });
    await w.call("cdb-jira:bounds", w.claude, { x: 100, y: 0, width: 5000, height: 5000 });
    assert.deepEqual(plain(w.views[0].bounds), { x: 125, y: 30, width: 1075, height: 800 });
    assert.equal((await w.call("cdb-jira:bounds", w.claude, { x: 1, y: 1, width: -5, height: 1 })).ok, false);
  });
  await test("close rules: page x, claude.ai close, URL change, upstream view attach; focus returns to claude.ai", async () => {
    const w = world(path.join(temp, "w-close"));
    await on(w);
    let listener = null;
    w.ctx.__cdbJiraOnNativeViewAttached = (f) => { listener = f; };
    w.emitApp("ready");
    await new Promise((r) => setTimeout(r, 5));
    const reopen = async () => { await w.call("cdb-jira:open", w.claude, RECT); assert.equal(w.views[0].visible, true); };
    await reopen();
    const before = w.claude.focused;
    assert.equal((await w.call("cdb-jira:hide", w.views[0].webContents)).ok, true);
    assert.equal(w.views[0].visible, false); assert.ok(w.claude.focused > before);
    assert.ok(w.claude.js.includes("window.__cdbJiraWeb&&window.__cdbJiraWeb.setActive(false)"));
    await reopen(); await w.call("cdb-jira:close", w.claude); assert.equal(w.views[0].visible, false);
    await reopen(); w.claude.emit("did-navigate-in-page", {}, "https://claude.ai/new?x=1#y", true); assert.equal(w.views[0].visible, true, "query or hash only: stays open");
    w.claude.emit("did-navigate-in-page", {}, "https://claude.ai/chat/1", false); assert.equal(w.views[0].visible, true, "subframe: stays open");
    w.claude.emit("did-navigate-in-page", {}, "https://claude.ai/chat/1", true); assert.equal(w.views[0].visible, false);
    await reopen(); assert.ok(listener, "hook registered"); listener(w.win); assert.equal(w.views[0].visible, false);
    await reopen(); listener({ other: true }); assert.equal(w.views[0].visible, true, "another window's attach is ignored");
    assert.equal(w.views.length, 1, "the view is kept alive and reused");
    await w.call("cdb-jira:close", w.claude);
    const routes = [];
    w.ctx.__cdbNavigation = { getDispatcher: (wc) => (wc === w.claude ? { dispatchNavigate: (r) => { routes.push(r); setTimeout(() => { w.claude.url = "https://claude.ai" + r; }, 20); } } : null) };
    w.claude.url = "https://claude.ai/epitaxy/local_7?tab=1";
    w.claude.emit("did-navigate-in-page", {}, w.claude.url, true);
    w.claude.url = "https://claude.ai/settings/desktop";
    w.claude.emit("did-navigate-in-page", {}, w.claude.url, true);
    const opened = await w.call("cdb-jira:open", w.claude, RECT);
    assert.equal(opened.ok, true);
    assert.deepEqual(routes, ["/epitaxy/local_7?tab=1"], "Settings is left for the last route outside it first");
    assert.equal(w.views[0].visible, true, "the page opens after Settings has closed");
    w.claude.emit("did-navigate-in-page", {}, "https://claude.ai/epitaxy/local_7?tab=2", true);
    assert.equal(w.views[0].visible, true, "the route change that left Settings does not close the page");
  });
  await test("window maximize, resize or claude.ai view bounds change re-apply the page bounds without a push from the web script", async () => {
    const w = world(path.join(temp, "w-refit"));
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    const v = w.views[0], wait = () => new Promise((r) => setTimeout(r, 90));
    assert.deepEqual(plain(v.bounds), { x: 260, y: 30, width: 940, height: 800 });
    w.claudeView.box = { x: 0, y: 30, width: 2000, height: 1400 };
    w.claude.js.length = 0;
    w.claude.jsResult = { x: 280, y: 0, width: 1720, height: 1400 };
    for (const n of ["maximize", "resize", "resize"]) w.win.emit(n);
    await wait();
    assert.equal(w.claude.js.filter((c) => c.includes("__cdbJiraWeb.rect()")).length, 1, "one fresh measurement per burst");
    assert.deepEqual(plain(v.bounds), { x: 280, y: 30, width: 1720, height: 1400 });
    w.claude.jsResult = { x: 0, y: 0, width: 2000, height: 1400 };
    w.claudeView.emit("bounds-changed");
    await wait();
    assert.deepEqual(plain(v.bounds), { x: 0, y: 30, width: 2000, height: 1400 });
    w.claude.jsResult = { x: -5, y: 0, width: 1, height: 1 };
    w.win.emit("unmaximize"); await wait();
    assert.deepEqual(plain(v.bounds), { x: 0, y: 30, width: 2000, height: 1400 }, "a bad rectangle is ignored");
    await w.call("cdb-jira:close", w.claude);
    w.claude.js.length = 0;
    w.win.emit("resize"); await wait();
    assert.equal(w.claude.js.filter((c) => c.includes("__cdbJiraWeb.rect()")).length, 0, "nothing is measured while the page is closed");
  });
  await test("close: focus returns to claude.ai even when the hide drops it, and the window keeps focus it had", async () => {
    const w = world(path.join(temp, "w-focus"));
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    w.win.hasFocus = true; w.claude.hasFocus = false;
    const f0 = w.claude.focused;
    await w.call("cdb-jira:hide", w.views[0].webContents);
    w.win.hasFocus = false;
    await new Promise((r) => setTimeout(r, 90));
    assert.ok(w.claude.focused >= f0 + 2, "claude.ai is focused again after the hide settles");
    assert.equal(w.win.focusCalls, 1, "the window had focus when the page closed, so it gets it back");
    await w.call("cdb-jira:open", w.claude, RECT);
    w.win.hasFocus = false; w.win.focusCalls = 0;
    await w.call("cdb-jira:hide", w.views[0].webContents);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(w.win.focusCalls, 0, "a window without focus is not raised");
  });
  await test("cover: the page learns whether it covers the whole view, so only then it shows a close button", async () => {
    const w = world(path.join(temp, "w-cover"));
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    const tw = w.views[0].webContents, covers = () => (tw.sent || []).filter((x) => x[0] === "cdb-jira:cover").map((x) => x[1]);
    assert.deepEqual(covers(), [false]);
    assert.deepEqual(await w.call("cdb-jira:cover", tw), { ok: true, full: false });
    await w.call("cdb-jira:bounds", w.claude, { x: 0, y: 0, width: 1200, height: 800 });
    await w.call("cdb-jira:bounds", w.claude, { x: 0, y: 0, width: 1100, height: 800 });
    assert.deepEqual(covers(), [false, true], "pushed on change only");
    assert.deepEqual(await w.call("cdb-jira:cover", tw), { ok: true, full: true });
    await w.call("cdb-jira:bounds", w.claude, RECT);
    assert.deepEqual(covers(), [false, true, false]);
    assert.match((await w.call("cdb-jira:cover", w.claude)).error, /unrecognized sender/);
  });
  await test("zoom: the page renders at claude.ai's zoom, follows its changes, and zoom keys in the page zoom claude.ai", async () => {
    const w = world(path.join(temp, "w-zoom"), { zoom: 1.2 });
    await on(w);
    await w.call("cdb-jira:open", w.claude, RECT);
    const tw = w.views[0].webContents, wait = () => new Promise((r) => setTimeout(r, 90));
    assert.equal(tw.zoom, 1.2, "the tracker copies claude.ai's zoom on open");
    w.claude.jsResult = { x: 260, y: 0, width: 940, height: 800 };
    w.claude.zoom = 1.5; w.claude.emit("zoom-changed", {}, "in");
    await wait();
    assert.equal(tw.zoom, 1.5, "a claude.ai zoom change reaches the tracker");
    const press = (k, extra = {}) => { let n = 0; tw.emit("before-input-event", { preventDefault: () => n++ }, { type: "keyDown", control: true, shift: false, alt: false, meta: false, key: k, ...extra }); return n; };
    const lvl = () => Math.round(w.claude.getZoomLevel() * 100) / 100;
    const tick = () => new Promise((r) => setTimeout(r, 5));
    tw.jsResult = false;
    const l0 = lvl();
    assert.equal(press("="), 1, "Ctrl+= in the page is taken");
    await tick();
    assert.ok(tw.js.some((c) => /__cdbJiraLightboxKey\("\+"\)/.test(c)), "the page is asked first");
    assert.equal(lvl(), Math.round((l0 + 0.5) * 100) / 100, "and, with no lightbox open, claude.ai zooms");
    assert.equal(Math.round(tw.zoom * 1000), Math.round(w.claude.zoom * 1000), "the two stay equal");
    assert.equal(press("-"), 1); await tick();
    assert.equal(press("+", { shift: true }), 1); await tick();
    assert.equal(press("0"), 1); await tick();
    assert.equal(w.claude.zoom, 1); assert.equal(tw.zoom, 1, "Ctrl+0 resets both");
    tw.jsResult = true;
    assert.equal(press("="), 1); await tick();
    assert.equal(w.claude.zoom, 1, "a lightbox in the page takes the key; claude.ai keeps its zoom");
    tw.jsResult = false;
    for (const [why, fake, waitMs] of [["a truthy non-true answer", () => Promise.resolve("yes"), 5], ["a throwing page", () => Promise.reject(new Error("boom")), 5], ["a page that never answers (200 ms)", () => new Promise(() => {}), 260]]) {
      const keep = tw.executeJavaScript, z0 = w.claude.zoom;
      tw.executeJavaScript = fake;
      assert.equal(press("="), 1);
      await new Promise((r) => setTimeout(r, waitMs));
      assert.ok(w.claude.zoom > z0, why + " still zooms claude.ai");
      tw.executeJavaScript = keep;
      press("0"); await tick();
    }
    tw.jsResult = false;
    assert.equal(press("a"), 0, "other keys are left alone");
    tw.zoom = 2; tw.emit("zoom-changed", {}, "in");
    await wait();
    assert.equal(tw.zoom, 1, "a wheel zoom inside the page snaps back to claude.ai's zoom");
  });
  await test("shortcut: Ctrl+Shift+J toggles from claude.ai and from the tracker; nothing with the switch off", async () => {
    const w = world(path.join(temp, "w-key"));
    const key = (wc) => { let n = 0; wc.emit("before-input-event", { preventDefault: () => n++ }, { type: "keyDown", control: true, shift: true, alt: false, meta: false, key: "J" }); return n; };
    assert.equal(key(w.claude), 0); assert.equal(w.claude.js.length, 0);
    await on(w);
    w.claude.jsResult = false;
    assert.equal(key(w.claude), 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(w.claude.js.includes("window.__cdbJiraWeb?window.__cdbJiraWeb.open():false"));
    assert.equal(w.views[0].visible, true, "no web script: main opens over the whole view");
    assert.deepEqual(plain(w.views[0].bounds), { x: 0, y: 30, width: 1200, height: 800 });
    assert.equal(key(w.views[0].webContents), 1); assert.equal(w.views[0].visible, false);
    assert.equal(key(w.popout), 0);
  });
  await test("switching on injects the web script into the main view only; switching off destroys the view and removes the row", async () => {
    const w = world(path.join(temp, "w-switch"));
    await on(w);
    assert.equal(w.claude.js.filter((c) => c.includes("__cdbJiraWeb = {")).length, 1);
    assert.equal(w.popout.js.length, 0);
    w.claude.emit("dom-ready");
    assert.equal(w.claude.js.filter((c) => c.includes("__cdbJiraWeb = {")).length, 2, "re-injected per document");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.claude.css.length, 2, "row CSS inserted with each injection");
    assert.equal(w.popout.css.length, 0);
    for (const rule of w.claude.css[0].split("}").filter((s) => s.trim())) assert.match(rule.trim(), /^\[data-testid="sidebar"\] \.cdb-jira-row-active/, "every rule is scoped to our class under the sidebar");
    assert.deepEqual(w.claude.cssRemoved, ["css-1"], "the second injection removes the first stylesheet");
    await w.call("cdb-jira:open", w.claude, RECT);
    const t = w.views[0].webContents;
    await w.call("cdb-jira-pref:set", w.claude, { enabled: false });
    assert.equal(t.destroyed, true); assert.ok(!w.win.contentView.children.includes(w.views[0]));
    assert.ok(w.claude.js.includes("window.__cdbJiraWeb&&window.__cdbJiraWeb.remove()"));
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(w.claude.cssRemoved, ["css-1", "css-2"], "switch-off removes the row CSS");
    assert.match((await w.call("cdb-jira:open", w.claude, RECT)).error, /switched off/);
  });
  await test("a claude.ai view attached after its dom-ready still gets the web script", async () => {
    const w = world(path.join(temp, "w-late"));
    await on(w);
    const late = w.wc(7, "https://claude.ai/new");
    late.emit("dom-ready");
    assert.equal(late.js.length, 0);
    w.win.contentView.children.push({ webContents: late, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) });
    await new Promise((r) => setTimeout(r, 650));
    assert.equal(late.js.filter((c) => c.includes("__cdbJiraWeb = {")).length, 1);
  });
  console.log(`PASS ${passed} Jira IPC tests`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
