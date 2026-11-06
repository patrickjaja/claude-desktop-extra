#!/usr/bin/env node
/*
 * test-dev-tools-toggle.mjs - the "Developer tools" community switch
 * (patches/community/add_feature_dev_tools_toggle.nim -> js/dev_tools_toggle_main.js).
 *
 * Runs the real module with electron shimmed and a temporary userData dir,
 * the same vm-sandbox the allow-non-anthropic-models harness uses. Checks the
 * cdb-dt:* IPC shape against upstream's developer_settings.json contract
 * (only an explicit true is on; other keys survive a write; an unparsable file
 * is replaced instead of left to raise upstream's startup dialog), the
 * exact-origin, main-frame-only sender guard, then runs the compiled patch on
 * a bundle-head fixture (marker, idempotency, syntax).
 *
 * Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE_PATH = join(ROOT, "js/dev_tools_toggle_main.js");
const PATCH_BIN = join(ROOT, "patches", "community", "add_feature_dev_tools_toggle");
const SKIP_EXIT = 3;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

if (!existsSync(MODULE_PATH)) {
  console.log("  FAIL js/dev_tools_toggle_main.js is missing");
  process.exit(1);
}

function load(dir) {
  const handlers = {};
  const electron = {
    app: { getPath: () => dir, on: () => {}, whenReady: () => Promise.resolve() },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }
  };
  const sandbox = {
    require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env: {}, pid: process.pid }, console, setTimeout, clearTimeout
  };
  sandbox.globalThis = sandbox;
  { const __c = vm.createContext(sandbox);
    vm.runInContext(readFileSync(new URL("../../../js/sender_guard.js", import.meta.url), "utf8"), __c);
    vm.runInContext(readFileSync(MODULE_PATH, "utf8"), __c); }
  return { handlers, sandbox };
}
const from = (u, parent = null) => ({ sender: { getURL: () => u, isDestroyed: () => false }, senderFrame: { parent } });
const sender = from("https://claude.ai/new");
const file = (dir) => join(dir, "developer_settings.json");

console.log("\nA. IPC shape against upstream's file contract");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-dt-"));
  const t = load(dir);
  ok(typeof t.handlers["cdb-dt:pref-read"] === "function" && typeof t.handlers["cdb-dt:pref-set"] === "function",
     "both channels registered");
  const r = await t.handlers["cdb-dt:pref-read"](sender);
  ok(r.ok === true && r.enabled === false && r.source === "missing", "read: no file -> off, source missing: " + JSON.stringify(r));
  ok(r.key === "allowDevTools" && r.path.endsWith("developer_settings.json"), "read reports upstream's key and path");

  const s = await t.handlers["cdb-dt:pref-set"](sender, true);
  ok(s.ok === true && s.enabled === true && s.replacedInvalid === false, "set(true) writes: " + JSON.stringify(s));
  ok(JSON.parse(readFileSync(file(dir), "utf8")).allowDevTools === true, "the file carries allowDevTools: true");
  const r2 = await t.handlers["cdb-dt:pref-read"](sender);
  ok(r2.enabled === true && r2.source === "file", "read after set: on, source file");

  const s2 = await t.handlers["cdb-dt:pref-set"](sender, false);
  ok(s2.ok === true && JSON.parse(readFileSync(file(dir), "utf8")).allowDevTools === false, "set(false) writes false (not a deleted key)");
  ok((await t.handlers["cdb-dt:pref-read"](sender)).enabled === false, "read after set(false): off");

  const bad = await t.handlers["cdb-dt:pref-set"](sender, "yes");
  ok(bad.ok === false && /boolean/.test(bad.error), "set rejects a non-boolean: " + JSON.stringify(bad));
  rmSync(dir, { recursive: true });
}

console.log("\nB. Other keys survive, truthy-but-not-true is off, invalid file is replaced");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-dt-"));
  writeFileSync(file(dir), '{"futureKey": {"x": 1}, "allowDevTools": "true"}');
  const t = load(dir);
  ok((await t.handlers["cdb-dt:pref-read"](sender)).enabled === false, "a string \"true\" reads as off (only boolean true is on)");
  await t.handlers["cdb-dt:pref-set"](sender, true);
  const obj = JSON.parse(readFileSync(file(dir), "utf8"));
  ok(obj.allowDevTools === true && obj.futureKey && obj.futureKey.x === 1, "set keeps the other keys: " + JSON.stringify(obj));

  writeFileSync(file(dir), "{not json");
  const r = await t.handlers["cdb-dt:pref-read"](sender);
  ok(r.ok === true && r.enabled === false && r.source === "invalid", "read: unparsable file -> off, source invalid");
  const s = await t.handlers["cdb-dt:pref-set"](sender, true);
  ok(s.ok === true && s.replacedInvalid === true, "set replaces the unparsable file and says so");
  ok(JSON.parse(readFileSync(file(dir), "utf8")).allowDevTools === true, "the replacement is valid JSON with the key");
  rmSync(dir, { recursive: true });
}

console.log("\nC. Sender guard");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-dt-"));
  const t = load(dir);
  for (const u of ["https://claude.ai/x", "https://preview.claude.ai/x", "https://claude.com/",
                   "https://preview.claude.com/x", "app://localhost/", "app://localhost/new?x=1"]) {
    const r = await t.handlers["cdb-dt:pref-read"](from(u));
    ok(r.ok === true, "accepted: " + u);
  }
  for (const u of ["https://evil.example/", "https://claude.ai.evil.example/", "app://localhost.evil/", "app://localhost:1234/",
                   "app://other/", "file:///home/u/x.html", "http://localhost:3000/", "http://claude.ai/", "not a url"]) {
    const r = await t.handlers["cdb-dt:pref-set"](from(u), true);
    ok(r.ok === false && /sender/.test(r.error), "rejected: " + u);
  }
  const sub = await t.handlers["cdb-dt:pref-set"](from("https://claude.ai/x", {}), true);
  ok(sub.ok === false, "rejected: a subframe of an allowed origin");
  const sub3p = await t.handlers["cdb-dt:pref-set"](from("app://localhost/", {}), true);
  ok(sub3p.ok === false, "rejected: an app://localhost subframe");
  ok(!existsSync(file(dir)), "rejected calls wrote nothing");
  rmSync(dir, { recursive: true });
}

console.log("\nD. Compiled patch on a bundle-head fixture");
try {
  accessSync(PATCH_BIN, constants.X_OK);
  const dir = mkdtempSync(join(tmpdir(), "cdb-dt-"));
  const fixture = join(dir, "index.js");
  writeFileSync(fixture, `"use strict";var upstream=1;`);
  const run = () => spawnSync(PATCH_BIN, [fixture], { encoding: "utf8" });
  ok(run().status === 0, "first run exits 0");
  const patched = readFileSync(fixture, "utf8");
  ok(patched.startsWith(`"use strict";`), "bundle still starts with the strict directive");
  ok(patched.split("__CDB_DEV_TOOLS_TOGGLE__").length - 1 === 1, "marker present once");
  ok(spawnSync(process.execPath, ["--check", fixture]).status === 0, "patched bundle passes node --check");
  ok(run().status === 0 && readFileSync(fixture, "utf8") === patched, "second run is idempotent");
  rmSync(dir, { recursive: true });
} catch {
  console.log("  SKIP patch binary not compiled: " + PATCH_BIN + " (cd patches && make)");
  if (fail === 0) { console.log(`\n${pass} passed, 0 failed (patch part skipped)`); process.exit(SKIP_EXIT); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
