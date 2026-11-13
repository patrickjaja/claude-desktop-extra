#!/usr/bin/env node
// patches/community/add_feature_jira_tracker on scripts/tests/fixtures/jira-tracker-chunk.js (4.23118.0 anchor shapes) plus a part with
// same-named decoys, staged like scripts/apply_patches.py; repeated on tmp/app.asar.contents when it is pristine. Needs Node 24+.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = path.join(root, "patches/community/add_feature_jira_tracker");
const CHUNK = fs.readFileSync(path.join(root, "scripts/tests/fixtures/jira-tracker-chunk.js"), "utf8");
const DECOY = '"use strict";var zz=new Set;function iCi(e){return zz.add(e),()=>{zz.delete(e)}}async function qC(){return 0}globalThis.decoy=1;\n';
const marker = (name) => `\n/*__CDB_SPLIT__${name}__*/\n`;
const STAGED = '"use strict";globalThis.stub=1;\n' + marker("index.chunk-a.js") + CHUNK + marker("index.chunk-b.js") + DECOY;
const SESSIONS = "}globalThis.__cdbJiraSessions=qC;async function qC(){";
const ATTACHED = "function iCi(e){return rCi.add(e),()=>{rCi.delete(e)}}globalThis.__cdbJiraOnNativeViewAttached=iCi;function aCi(";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-jira-tracker-patch-"));
const file = path.join(temporary, "staged.js");
const nodeRequire = createRequire(import.meta.url);
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("PASS " + name); };

function patch(text) {
  if (!fs.existsSync(binary)) throw new Error(`binary missing: ${binary} (run bash scripts/compile-nim-patches.sh)`);
  fs.writeFileSync(file, text);
  const run = spawnSync(binary, [file], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout || "", stderr: run.stderr || "", text: fs.readFileSync(file, "utf8") };
}
function split(text) {
  const pieces = text.split(/\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/);
  const parts = [{ name: "index.js", text: pieces[0] }];
  for (let i = 1; i < pieces.length; i += 2) parts.push({ name: pieces[i], text: pieces[i + 1] });
  return parts;
}
function nodeCheck(parts) {
  for (const part of parts) {
    const out = path.join(temporary, part.name);
    fs.writeFileSync(out, part.text);
    const check = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
    assert.equal(check.status, 0, part.name + ": " + check.stderr.slice(-300));
  }
}
try {
  const once = patch(STAGED);
  const [index, chunkA, chunkB] = split(once.text);
  await test("applies: exit 0, three sub-patches, no 'already' on a first run, node --check per part", () => {
    assert.equal(once.status, 0, once.stdout + once.stderr);
    for (const line of ["[OK] A module injected", "[OK] B session-manager accessor captured", "[OK] C native-view attach registry captured"]) assert.ok(once.stdout.includes(line), line);
    assert.ok(!/already/i.test(once.stdout));
    nodeCheck(split(once.text));
  });
  await test("placement: the module leads index.js; B and C land in the part that exports them; decoys untouched", () => {
    assert.ok(index.text.startsWith('"use strict";;/*__CDB_JIRA_ADF__*/'));
    assert.equal(index.text.split("/*__CDB_JIRA_TRACKER__*/").length - 1, 1);
    assert.equal(chunkA.text.split(SESSIONS).length - 1, 1);
    assert.equal(chunkA.text.split(ATTACHED).length - 1, 1);
    assert.equal(chunkB.text, DECOY);
    for (const slot of ["__CDB_JIRA_PAGE_HTML__", "__CDB_JIRA_PAGE_JS__", "__CDB_JIRA_ADF_SRC__", "__CDB_JIRA_PRELOAD__", "__CDB_JIRA_WEB_SRC__"]) assert.ok(!once.text.includes('"' + slot + '"'), slot);
  });
  await test("idempotent: the second run changes nothing and reports three already-present sub-patches", () => {
    const twice = patch(once.text);
    assert.equal(twice.status, 0, twice.stdout); assert.equal(twice.text, once.text);
    assert.equal((twice.stdout.match(/already (present|captured) \(idempotent\)/g) || []).length, 3);
  });
  await test("captures: __cdbJiraSessions resolves upstream's manager; __cdbJiraOnNativeViewAttached sees an attach", async () => {
    const ctx = vm.createContext({ require: () => { throw new Error("no chunk load expected"); }, Promise });
    vm.runInContext(chunkA.text, ctx);
    const manager = { id: "manager" };
    ctx.__fixture.setManager(manager);
    assert.equal(await ctx.__cdbJiraSessions(), manager);
    const seen = [];
    ctx.__cdbJiraOnNativeViewAttached((w) => seen.push(w));
    ctx.__fixture.aCi("main-window");
    assert.deepEqual(seen, ["main-window"]);
  });
  await test("the injected module loads and registers its channels", async () => {
    const handlers = [];
    const electron = { app: { getPath: () => temporary, on() {}, whenReady: () => Promise.resolve() }, ipcMain: { handle: (ch) => handlers.push(ch), removeHandler() {} },
      safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: { getAllWindows: () => [] }, webContents: { getAllWebContents: () => [] }, dialog: {}, shell: {} };
    const ctx = vm.createContext({ require: (m) => (m === "electron" ? electron : nodeRequire(m)), process: { platform: "linux", env: {} }, Buffer, URL, AbortController, setTimeout, clearTimeout, console });
    vm.runInContext(index.text, ctx);
    assert.deepEqual(handlers.sort(), ["cdb-jira-pref:read", "cdb-jira-pref:set", "cdb-jira-pref:test", "cdb-jira:attachment", "cdb-jira:board", "cdb-jira:bounds", "cdb-jira:children", "cdb-jira:close", "cdb-jira:cover", "cdb-jira:details", "cdb-jira:download", "cdb-jira:drop", "cdb-jira:hide", "cdb-jira:issue", "cdb-jira:move",
      "cdb-jira:open", "cdb-jira:open-external", "cdb-jira:open-settings", "cdb-jira:projects", "cdb-jira:query-delete", "cdb-jira:query-save", "cdb-jira:search",
      "cdb-jira:send", "cdb-jira:state", "cdb-jira:theme", "cdb-jira:transition", "cdb-jira:transitions"]);
  });
  const broken = {
    "duplicate export key": STAGED.replace("getClaudeCodeSessionManager:()=>qC,", "getClaudeCodeSessionManager:()=>qC,getClaudeCodeSessionManager:()=>qC,"),
    "accessor reshaped": STAGED.replace("if(KC)return KC;", "if(KC)return KC.x;"),
    "accessor defined twice in its part": STAGED.replace("function JC(){return KC}", "async function qC(){return 1}function JC(){return KC}"),
    "attach export renamed": STAGED.replace("onNativeViewAttached:()=>iCi", "onViewAttached:()=>iCi"),
    "attach registry reshaped": STAGED.replace("return rCi.add(e),", "return rCi.add(e+1),"),
    "half-patched input": once.text.replace("globalThis.__cdbJiraOnNativeViewAttached=iCi;", "")
  };
  for (const [name, text] of Object.entries(broken)) {
    await test(`rejects: ${name} (exit != 0, file untouched)`, () => {
      assert.ok(text !== STAGED && text !== once.text, name + ": the fixture edit did not apply");
      const r = patch(text);
      assert.notEqual(r.status, 0, r.stdout); assert.equal(r.text, text);
    });
  }
  const build = path.join(root, "tmp/app.asar.contents/.vite/build");
  const parts = fs.existsSync(build) ? ["index.js", ...fs.readdirSync(build).filter((n) => /^index.*\.chunk-.*\.js$/.test(n)).sort()] : [];
  const pristine = parts.length > 1 && parts.some((n) => fs.readFileSync(path.join(build, n), "utf8").includes("getClaudeCodeSessionManager:()=>"));
  if (pristine) await test("pristine release: one run, node --check per changed part, byte-idempotent", () => {
    const staged = parts.map((n, i) => (i ? marker(n) : "") + fs.readFileSync(path.join(build, n), "utf8")).join("");
    assert.ok(!staged.includes("__cdb"), "tmp/app.asar.contents must be pristine");
    const first = patch(staged); assert.equal(first.status, 0, first.stdout + first.stderr);
    const out = split(first.text); assert.equal(out.length, parts.length);
    nodeCheck(out.filter((p, i) => p.text !== fs.readFileSync(path.join(build, parts[i]), "utf8")));
    assert.equal(first.text.split("globalThis.__cdbJiraSessions=").length - 1, 1);
    assert.equal(first.text.split("globalThis.__cdbJiraOnNativeViewAttached=").length - 1, 1);
    const second = patch(first.text); assert.equal(second.status, 0); assert.equal(second.text, first.text);
  });
  else console.log("SKIP pristine release check: tmp/app.asar.contents is missing or not a pristine code-split extract");
  console.log(`PASS ${passed} Jira tracker patch tests`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
