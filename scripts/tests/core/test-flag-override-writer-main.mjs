#!/usr/bin/env node
/*
 * test-flag-override-writer-main.mjs - main-process tests for the single writer
 * of growthbookOverrides (cdb-flags:set / cdb-flags:unset / cdb-flags:read in
 * js/extra_settings_main.js). Two pages drive it: Settings -> Extra -> Anthropic
 * (every flag) and the "Drawn cursor in the glow" row of Extra -> Cowork (Linux)
 * (flag 1916550538). What must hold for both:
 *   - set stores the boolean under the id, everything else in the file stays;
 *   - unset deletes the key, and the growthbookOverrides object with its last key;
 *   - an id the catalog does not know, a non-scalar value, a foreign sender and
 *     a flag the hand-edited .jsonc already sets are all refused;
 *   - read reports what was written, so the page that did not write it shows it.
 * Real files in a temp dir; electron and the growthbook store are shimmed.
 *
 * Usage: node scripts/tests/core/test-flag-override-writer-main.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require2 = createRequire(import.meta.url);
let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  fail++;
  console.error("  FAIL " + label + (extra !== undefined ? "  -> " + extra : ""));
}
function section(t) { console.log("\n" + t); }

const ID = "1916550538";
const base = mkdtempSync(join(tmpdir(), "cdb-flagw-"));
const userData = join(base, "Claude");
mkdirSync(userData, { recursive: true });
const jsonPath = join(userData, "claude-desktop-extra.json");
const jsoncPath = join(userData, "claude-desktop-extra.jsonc");
const readJson = () => JSON.parse(readFileSync(jsonPath, "utf8"));

globalThis.__cdbDiag = () => {};
globalThis.__cdbGbFlags = {
  version: 1,
  catalog: () => [
    { id: ID, note: "Computer Use glow when Claude has the pointer", valueFlag: false, warn: "" },
    { id: "1001", note: "DO NOT ENABLE this", valueFlag: false, warn: "DO NOT ENABLE this" }
  ],
  server: () => ({ [ID]: { on: false, value: false } }),
  effective: () => ({ [ID]: { on: false, value: false } }),
  builtins: () => ({}),
  overrides: () => ({}),
  configPath: () => ({ json: jsonPath, jsonc: jsoncPath })
};

const handlers = {};
const fakeElectron = {
  app: { getPath: () => userData, on: () => {}, once: () => {}, relaunch: () => {}, exit: () => {} },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} },
  shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} },
  nativeImage: {}
};
const Module = require2("module");
const orig = Module._load;
Module._load = function (req, ...rest) { return req === "electron" ? fakeElectron : orig.call(this, req, ...rest); };
const dir = mkdtempSync(join(tmpdir(), "cdb-flagw-mod-"));
const mod = join(dir, "extra.cjs");
writeFileSync(mod, readFileSync(join(ROOT, "js", "sender_guard.js"), "utf8") + readFileSync(join(ROOT, "js", "extra_settings_main.js"), "utf8"));
try { require2(mod); } finally { Module._load = orig; }

const ev = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
const call = async (ch, ...args) => {
  if (!handlers[ch]) return { ok: false, error: "no handler for " + ch, missing: true };
  return await handlers[ch](ev, ...args);
};

section("registration");
ok(["cdb-flags:read", "cdb-flags:set", "cdb-flags:unset"].every((c) => typeof handlers[c] === "function"), "the three flag channels are registered");

section("set");
writeFileSync(jsonPath, JSON.stringify({ activeTheme: "x", computerUseBackgroundDisplay: { enabled: false } }));
let r = await call("cdb-flags:set", ID, true);
ok(r.ok === true, "set " + ID + "=true answers ok", JSON.stringify(r));
ok(readJson().growthbookOverrides && readJson().growthbookOverrides[ID] === true, "the boolean true is stored under the id");
ok(readJson().activeTheme === "x" && readJson().computerUseBackgroundDisplay.enabled === false, "the other keys of the file are untouched");
r = await call("cdb-flags:set", ID, false);
ok(r.ok === true && readJson().growthbookOverrides[ID] === false, "set false stores the boolean false (forced off), not a deleted key");
r = await call("cdb-flags:read");
ok(r.ok === true && r.overridesJson[ID] === false, "read reports the stored override for the other page", JSON.stringify(r.overridesJson));

section("unset");
writeFileSync(jsonPath, JSON.stringify({ growthbookOverrides: { [ID]: true, "1002": true }, keep: 1 }));
r = await call("cdb-flags:unset", ID);
ok(r.ok === true && !(ID in readJson().growthbookOverrides) && readJson().growthbookOverrides["1002"] === true, "unset deletes only that key");
writeFileSync(jsonPath, JSON.stringify({ growthbookOverrides: { [ID]: true }, keep: 1 }));
r = await call("cdb-flags:unset", ID);
ok(r.ok === true && !("growthbookOverrides" in readJson()) && readJson().keep === 1, "the last key takes growthbookOverrides with it");
r = await call("cdb-flags:read");
ok(r.ok === true && !(ID in r.overridesJson), "read no longer reports it");

section("refusals");
r = await call("cdb-flags:set", "999999", true);
ok(r.ok === false && !r.missing && /unknown flag id/.test(r.error), "an id outside the catalog is refused", JSON.stringify(r));
r = await call("cdb-flags:unset", "999999");
ok(r.ok === false && /unknown flag id/.test(r.error), "unset of an unknown id is refused too");
r = await call("cdb-flags:set", ID, { on: true });
ok(r.ok === false && !r.missing, "a non-scalar value is refused");
r = await call("cdb-flags:set", "1001", true);
ok(r.ok === false && /DO NOT ENABLE/.test(r.error), "a flag the catalog marks DO NOT ENABLE cannot be switched on");
writeFileSync(jsoncPath, '{ "growthbookOverrides": { "' + ID + '": true } }');
r = await call("cdb-flags:set", ID, false);
ok(r.ok === false && /claude-desktop-extra\.jsonc/.test(r.error), "a flag the .jsonc sets is refused: the file wins", JSON.stringify(r));
r = await call("cdb-flags:read");
ok(r.ok === true && r.overridesJsonc[ID] === true, "read reports the .jsonc lock so the page can show it");
const evil = { sender: { isDestroyed: () => false, getURL: () => "https://evil.example/" }, senderFrame: { parent: null } };
r = await handlers["cdb-flags:set"](evil, ID, true);
ok(r && r.ok === false, "a foreign sender is refused", JSON.stringify(r));
ok(!existsSync(jsonPath + ".cdb-tmp"), "no temp file is left behind");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
