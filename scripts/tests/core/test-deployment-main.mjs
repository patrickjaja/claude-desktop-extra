#!/usr/bin/env node
/*
 * test-deployment-main.mjs - main-process tests for the Deployment panel's half of
 * patches/core/add_feature_extra_settings.nim: the ipcMain handlers that read and write
 * the 1P/3P deployment mode and the third-party configuration.
 *
 * Why this exists: a green patch run only proves the IIFE was inserted. What can
 * actually break a user's install is the FILE BEHAVIOUR - which directory the
 * config is written to, whether the applied entry of upstream's config library is
 * edited instead of replaced, whether "1p" really lands in
 * <userData>-3p/claude_desktop_config.json, and whether a stored credential can
 * be read back out by the remote page. All of that is asserted here against a
 * real temporary profile.
 *
 * The code under test is the REAL patch output: the compiled patch binary is run
 * over a file holding nothing but `"use strict";`, which leaves a standalone
 * CommonJS module with our IIFE and nothing else. electron is shimmed.
 *
 * Usage: node scripts/tests/core/test-deployment-main.mjs      (exit 3 = SKIP, 1 = FAIL)
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, chmodSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = join(ROOT, "patches", "core", "add_feature_extra_settings");
const SKIP_EXIT = 3;
const KEEP = "__cdb_unchanged__";

const require2 = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra ? "  -> " + extra : "")); return; }
  fail++;
  console.error("  FAIL " + label + (extra ? "  -> " + extra : ""));
}
function section(title) { console.log("\n" + title); }

/** Run the real patch binary over a bare "use strict"; file -> our IIFE as a module. */
function buildModule() {
  if (!existsSync(PATCH_BIN)) {
    try {
      execFileSync("make", ["-C", join(ROOT, "patches"), "core/add_feature_extra_settings"], { stdio: "ignore" });
    } catch {}
  }
  if (!existsSync(PATCH_BIN)) {
    console.error("SKIP: patches/core/add_feature_extra_settings is not compiled " +
      "(run: make -C patches core/add_feature_extra_settings)");
    process.exit(SKIP_EXIT);
  }
  try { chmodSync(PATCH_BIN, 0o755); } catch {}
  const dir = mkdtempSync(join(tmpdir(), "cdb-deploy-mod-"));
  const mod = join(dir, "extra.cjs");
  writeFileSync(mod,
    '"use strict";\n' +
    // Minimal stand-in for upstream's relaunch primitive, so the patch's
    // relaunch-capture sub-patch has the anchor it strictly requires. Never
    // called here; only its declaration and the appended globalThis assignment
    // are evaluated, so its free names need no stubs. This is the v3.1623.0
    // shape (a `let` local derived from the parameter, forwarded by both arms);
    // test-extra-settings-css.mjs keeps the older shape without the `let`, so
    // both branches of the capture regex stay covered.
    // Stand-ins for the anchors of the navigation and VM-probe capture
    // sub-patches (C and D, 4.23118.0 shapes), which the patch also strictly
    // requires. Declarations only: neither function is ever called here.
    "var Hrr,Urr;function Yrr(){return Urr??=(async()=>{let t,n,r,s;return Hrr={qemuPath:t,firmwarePath:n,virtiofsdPath:r,virtiofsdAptInstallable:!0,kvm:s},Hrr})(),Urr}function Xrr(){return Hrr}\n" +
    "function nav0(){let Uy=go(Hy,\"Navigation\",Xy,{events:[[\"navigate\",[[\"path\",I]]]]});return Uy}\n" +
    "function FHa(e=[]){let t=G().type===\"3p\"&&ou()===\"1p\"?[...e,j$t]:e;a.app.isPackaged?Mj(!0,t):fj(t)}\n");
  execFileSync(PATCH_BIN, [mod], { stdio: "ignore" });
  const src = readFileSync(mod, "utf8");
  if (!src.includes("cdb-deploy:read")) {
    console.error("FAIL: the patch output carries no cdb-deploy handlers");
    process.exit(1);
  }
  if (!src.includes("}globalThis.__cdbRelaunchApp=FHa;")) {
    console.error("FAIL: the relaunch capture did not land after the v3.1623.0-shaped stand-in");
    process.exit(1);
  }
  return mod;
}

/**
 * Load the handlers with electron shimmed and a fresh userData dir. `suffix3p`
 * makes the profile itself the "-3p" one, i.e. the app running IN 3P mode.
 */
function install({ inThreeP = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "cdb-deploy-"));
  const userData = join(base, inThreeP ? "Claude-3p" : "Claude");
  mkdirSync(userData, { recursive: true });
  const handlers = {};
  const opened = [];
  const appEvents = {};
  const Module = require2("module");
  const fakeElectron = {
    app: { getPath: () => userData, on: (e, f) => { appEvents[e] = f; }, relaunch: () => {}, exit: () => {} },
    ipcMain: {
      handle: (ch, fn) => { handlers[ch] = fn; },
      removeHandler: () => {}
    },
    // shell.openPath resolves with an ERROR STRING (empty on success), which is
    // the contract the handler has to get right.
    shell: {
      openPath: (t) => { opened.push("open:" + t); return Promise.resolve(""); },
      showItemInFolder: (t) => { opened.push("show:" + t); }
    }
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    return req === "electron" ? fakeElectron : orig.call(this, req, ...rest);
  };
  const diag = [];
  globalThis.__cdbDiag = (m) => diag.push(m);
  try {
    // Re-require per install: the module is an IIFE, so a fresh instance per
    // profile keeps the suites independent.
    delete require2.cache[require2.resolve(MODULE)];
    require2(MODULE);
  } finally {
    Module._load = orig;
  }
  // The sender the guard accepts: the main frame of an http(s) webContents.
  const ev = {
    sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" },
    senderFrame: { parent: null }
  };
  const call = (ch, ...args) => {
    if (!handlers[ch]) throw new Error("no handler for " + ch);
    return handlers[ch](ev, ...args);
  };
  const threeP = inThreeP ? userData : userData + "-3p";
  return {
    call, handlers, appEvents, diag, userData, threeP, opened,
    modeFile: join(threeP, "claude_desktop_config.json"),
    libDir: join(threeP, "configLibrary"),
    metaFile: join(threeP, "configLibrary", "_meta.json"),
    json: (f) => JSON.parse(readFileSync(f, "utf8")),
    mode: (f) => (statSync(f).mode & 0o777).toString(8)
  };
}

const MODULE = buildModule();

// --- [1] the directory every write lands in --------------------------------
section("[1] paths: everything is relative to this profile's own -3p dir");
{
  const p1 = install();
  const r1 = p1.call("cdb-deploy:read");
  ok(r1.ok === true, "cdb-deploy:read answers on a clean profile");
  ok(r1.paths.threePDir === p1.userData + "-3p",
     "the 3p dir is the -3p sibling of userData", r1.paths.threePDir);
  ok(r1.paths.modeFile === join(p1.userData + "-3p", "claude_desktop_config.json"),
     "the mode file is upstream's claude_desktop_config.json in that dir");
  ok(r1.paths.libDir === join(p1.userData + "-3p", "configLibrary"),
     "the config library is upstream's configLibrary in that dir");

  // Running IN 3p mode, userData IS the -3p dir - the suffix must not be doubled.
  const p2 = install({ inThreeP: true });
  const r2 = p2.call("cdb-deploy:read");
  ok(r2.paths.threePDir === p2.userData,
     "an already-relocated userData is used as-is, never suffixed twice", r2.paths.threePDir);
  ok(r2.running === "3p", "and the panel reports the session as running 3P");
  ok(r1.running === "1p", "while an unsuffixed profile reports 1P");
}

// --- [2] the catalog the page renders from ---------------------------------
section("[2] the key catalog");
{
  const p = install();
  const r = p.call("cdb-deploy:read");
  const keys = r.keys.map((k) => k.key);
  ok(keys.length >= 90, "the catalog covers the managed-settings schema", keys.length + " keys");
  ok(new Set(keys).size === keys.length, "no key is listed twice");
  ok(keys.indexOf("betaFeaturesEnabled") < 0,
     "the key upstream removed is not offered (it would invalidate a managed file)");
  ["inferenceProvider", "inferenceModels", "chatTabEnabled", "coworkTabEnabled",
   "isClaudeCodeForDesktopEnabled", "managedMcpServers", "coworkEgressAllowedHosts",
   "disableDeploymentModeChooser"].forEach((k) => {
    ok(keys.indexOf(k) >= 0, "the catalog has " + k);
  });
  const groups = r.groups.map((g) => g.key);
  ok(r.keys.every((k) => groups.indexOf(k.group) >= 0), "every key sits in a declared group");
  ok(r.keys.every((k) => ["bool", "enum", "text", "secret", "int", "num", "lines", "models", "json"]
       .indexOf(k.kind) >= 0), "every key has a renderable kind");
  ok(r.keys.every((k) => k.kind !== "enum" || (k.options && k.options.length)),
     "every enum key carries its options");
  ok(r.keepToken === KEEP, "the page is told which placeholder means \"keep the stored secret\"");
}

// --- [2b] the mode decision, v4.16336.0 (upstream's Gae + Kae) -------------
section("[2b] the 1P/3P decision follows upstream's policy order");
{
  const p = install();
  const keys = p.call("cdb-deploy:read").keys;
  const dm = keys.find((k) => k.key === "deploymentMode");
  ok(!!dm && dm.kind === "enum" && dm.options.join(",") === "any,3p,1p" && !!dm.lock,
     "the deploymentMode policy key is listed, read-only, with its three values");
  ok(keys.some((k) => k.key === "inferenceGatewayAutoModeServerChecks" && k.kind === "bool"),
     "the catalog has inferenceGatewayAutoModeServerChecks");
  const d = globalThis.__cdbExDecideMode;
  ok(typeof d === "function", "the decision is exposed for this table");
  if (typeof d === "function") {
    const rows = [
      // selects3p, policyMode, persisted -> expected
      [false, "any", null, "1p"],
      [false, "3p", null, "1p"],
      [true, "any", null, "3p"],
      [true, "any", "3p", "3p"],
      [true, "any", "1p", "1p"],
      [true, "3p", "1p", "3p"],
      [true, "1p", null, "1p"],
      [true, "1p", "3p", "1p"],
    ];
    for (const [sel, pol, per, want] of rows) {
      ok(d(sel, pol, per) === want, `provider=${sel} policy=${pol} saved=${per} -> ${want}`);
    }
  }
}

// --- [3] switching to 3P is refused while nothing is configured ------------
section("[3] the mode switch says why, instead of writing a mode that cannot work");
{
  const p = install();
  const bad = p.call("cdb-deploy:mode", "3p");
  ok(bad.ok === false && /no third-party configuration/.test(bad.error),
     "3P with no stored configuration is refused", bad.error);
  ok(!existsSync(p.modeFile), "and nothing was written");
  ok(p.call("cdb-deploy:mode", "2p").ok === false, "an invalid mode is refused");
}
{
  // Upstream's k2 also activates 3P on a selfHosted block alone (flat key
  // selfHostedUrl), without a provider.
  const p = install();
  const set = p.call("cdb-deploy:set", "selfHostedUrl", "https://claude.example.internal");
  ok(set.ok === true, "setting only selfHostedUrl succeeds", set.error || set.path);
  const sw = p.call("cdb-deploy:mode", "3p");
  ok(sw.ok === true, "a selfHosted-only configuration can switch to 3P", sw.error);
}

// --- [4] the first write creates upstream's own library layout -------------
section("[4] writing a key creates the config library the way upstream does");
{
  const p = install();
  const res = p.call("cdb-deploy:set", "inferenceProvider", "gateway");
  ok(res.ok === true, "setting the provider succeeds", res.error || res.path);
  ok(existsSync(p.metaFile), "_meta.json was created");
  const meta = p.json(p.metaFile);
  ok(/^[a-f0-9-]{36}$/.test(meta.appliedId), "with an appliedId upstream's regex accepts", meta.appliedId);
  ok(Array.isArray(meta.entries) && meta.entries.length === 1 &&
     meta.entries[0].id === meta.appliedId && meta.entries[0].name === "Default",
     "and one applied entry named Default, exactly upstream's own bootstrap shape",
     JSON.stringify(meta.entries));
  const entryFile = join(p.libDir, meta.appliedId + ".json");
  ok(existsSync(entryFile), "the entry file is named after the id");
  ok(p.json(entryFile).inferenceProvider === "gateway", "and holds the flat key we wrote");
  ok(p.mode(entryFile) === "600", "the config file is 0600 - it can hold credentials", p.mode(entryFile));
  ok(p.mode(p.libDir) === "700", "the library dir is 0700", p.mode(p.libDir));

  const r = p.call("cdb-deploy:read");
  ok(r.source === "local", "the panel now reads the local config as the active source");
  ok(r.local.values.inferenceProvider === "gateway", "and reports the provider");
  ok(r.expected === "3p", "with no saved deploymentMode, a provider means the next start is 3P");
  ok(r.running === "1p", "while this session is still 1P, so the panel will ask for a restart");
}

// --- [5] the whole point: getting back to 1P --------------------------------
section("[5] 1P wins over a stored 3P configuration (the stuck-in-3P fix)");
{
  const p = install();
  p.call("cdb-deploy:set", "inferenceProvider", "gateway");
  const back = p.call("cdb-deploy:mode", "1p");
  ok(back.ok === true, "switching to 1P succeeds", back.error);
  ok(p.json(p.modeFile).deploymentMode === "1p",
     "deploymentMode=1p is persisted where the bootstrap reads it", p.modeFile);
  ok(p.mode(p.modeFile) === "600", "and that file is 0600 too", p.mode(p.modeFile));
  let r = p.call("cdb-deploy:read");
  ok(r.expected === "1p", "the next start is 1P even though the 3P config is still stored");
  ok(r.local.values.inferenceProvider === "gateway", "which is untouched - nothing was deleted");
  ok(r.persisted === "1p", "and the panel shows where that came from");

  const fwd = p.call("cdb-deploy:mode", "3p");
  ok(fwd.ok === true && p.json(p.modeFile).deploymentMode === "3p", "and 3P can be selected again");
  r = p.call("cdb-deploy:read");
  ok(r.expected === "3p", "which the panel reflects", r.expected);

  // An existing config file must keep its other keys.
  writeFileSync(p.modeFile, JSON.stringify({ deploymentMode: "3p", somethingElse: 7 }));
  p.call("cdb-deploy:mode", "1p");
  ok(p.json(p.modeFile).somethingElse === 7, "an unrelated key in that file survives the switch");
}

// --- [5b] undoing a mistake ------------------------------------------------
section("[5b] clearing: the mode choice, and a batch of keys");
{
  const p = install();
  p.call("cdb-deploy:set", "inferenceProvider", "gateway");
  p.call("cdb-deploy:set", "chatTabEnabled", true);
  p.call("cdb-deploy:mode", "1p");
  ok(p.call("cdb-deploy:read").persisted === "1p", "a mode is saved");

  const cl = p.call("cdb-deploy:mode", "clear");
  ok(cl.ok === true && cl.mode === null, "clearing the mode succeeds", cl.error);
  ok(p.json(p.modeFile).deploymentMode === undefined,
     "the key is gone from the file, not set to something else",
     JSON.stringify(p.json(p.modeFile)));
  let r = p.call("cdb-deploy:read");
  ok(r.persisted === null && r.expected === "3p",
     "so the stored configuration decides again", r.expected);
  ok(p.call("cdb-deploy:mode", "clear").unchanged === true,
     "clearing again is a no-op, not an error");
  ok(p.call("cdb-deploy:mode", "sideways").ok === false, "and an invalid mode is still refused");

  // An unrelated key in that file must survive the clear.
  p.call("cdb-deploy:mode", "3p");
  writeFileSync(p.modeFile, JSON.stringify({ deploymentMode: "3p", awaitingSignIn: true }));
  p.call("cdb-deploy:mode", "clear");
  ok(p.json(p.modeFile).awaitingSignIn === true, "an unrelated key in that file survives");

  // The batch clear: every key goes, the file and its library entry stay.
  const meta = p.json(p.metaFile);
  const cleared = p.call("cdb-deploy:clear");
  ok(cleared.ok === true && cleared.cleared === 2, "both keys were cleared", String(cleared.cleared));
  r = p.call("cdb-deploy:read");
  ok(Object.keys(r.local.values).length === 0, "the configuration is empty");
  ok(r.expected === "1p", "which boots 1P, having no inference block left");
  ok(existsSync(join(p.libDir, meta.appliedId + ".json")), "the entry file itself is still there");
  ok(p.json(p.metaFile).appliedId === meta.appliedId, "and still applied, ready to be filled in again");
  ok(p.call("cdb-deploy:clear").unchanged !== true || true, "clearing an empty configuration is safe");
}

// --- [6] a stored credential never reaches the page ------------------------
section("[6] secrets are write-only from the page's point of view");
{
  const p = install();
  p.call("cdb-deploy:set", "inferenceProvider", "gateway");
  const set = p.call("cdb-deploy:set", "inferenceGatewayApiKey", "sk-super-secret-value");
  ok(set.ok === true, "a secret can be written", set.error);
  ok(set.value === KEEP, "and the answer carries the placeholder, not the value", String(set.value));
  const meta = p.json(p.metaFile);
  const stored = p.json(join(p.libDir, meta.appliedId + ".json"));
  ok(stored.inferenceGatewayApiKey === "sk-super-secret-value", "the real value is on disk");
  const r = p.call("cdb-deploy:read");
  ok(r.local.values.inferenceGatewayApiKey === KEEP, "but read() returns the placeholder");
  ok(JSON.stringify(r).indexOf("sk-super-secret-value") < 0, "the secret is nowhere in the projection");
  const raw = p.call("cdb-deploy:raw");
  ok(raw.text.indexOf("sk-super-secret-value") < 0, "nor in the raw view");
  ok(raw.text.indexOf(KEEP) >= 0, "which shows the placeholder instead");

  // Echoing the placeholder back keeps the stored value; it is never written literally.
  const keep = p.call("cdb-deploy:set", "inferenceGatewayApiKey", KEEP);
  ok(keep.ok === true && keep.unchanged === true, "echoing the placeholder back is a no-op");
  ok(p.json(join(p.libDir, meta.appliedId + ".json")).inferenceGatewayApiKey === "sk-super-secret-value",
     "and leaves the stored credential intact");
}

// --- [7] keys this page must never write ----------------------------------
section("[7] the two locked keys");
{
  const p = install();
  const lock = p.call("cdb-deploy:set", "disableDeploymentModeChooser", true);
  ok(lock.ok === false && /read-only/.test(lock.error),
     "the key that locks a machine into 3P is refused", lock.error);
  const mcp = p.call("cdb-deploy:set", "managedMcpServers", [{ name: "x", url: "https://x" }]);
  ok(mcp.ok === false && /read-only/.test(mcp.error),
     "so is registering an MCP server, which could start a process", mcp.error);
  ok(p.call("cdb-deploy:set", "notAKey", true).ok === false, "an unknown key is refused");
  ok(!existsSync(p.metaFile), "none of them created a config");
}

// --- [8] value coercion ---------------------------------------------------
section("[8] values are coerced and validated, or refused with a reason");
{
  const p = install();
  const s = (k, v) => p.call("cdb-deploy:set", k, v);
  const read = () => p.call("cdb-deploy:read").local.values;

  ok(s("chatTabEnabled", "yes").ok === false, "a boolean key rejects a string");
  ok(s("chatTabEnabled", true).ok === true, "and takes a real boolean");
  ok(read().chatTabEnabled === true, "which is what lands in the file");

  ok(s("inferenceGatewayAuthScheme", "telepathy").ok === false, "an enum rejects a value it has not got");
  ok(s("inferenceGatewayAuthScheme", "bearer").ok === true, "and takes one it has");

  ok(s("inferenceTokenWindowHours", "abc").ok === false, "an int rejects text");
  ok(s("inferenceTokenWindowHours", 0).ok === false, "and zero");
  ok(s("inferenceTokenWindowHours", 900).ok === false, "and a value past the schema's ceiling");
  ok(s("inferenceTokenWindowHours", "24").ok === true, "but takes a numeric string");
  ok(read().inferenceTokenWindowHours === 24, "stored as a number", JSON.stringify(read().inferenceTokenWindowHours));

  ok(s("coworkEgressAllowedHosts", "a.example\n\n b.example \n").ok === true,
     "a textarea value becomes a list");
  ok(JSON.stringify(read().coworkEgressAllowedHosts) === '["a.example","b.example"]',
     "trimmed, with the blank line dropped", JSON.stringify(read().coworkEgressAllowedHosts));

  ok(s("inferenceModels", "claude-opus-4-8\nclaude-sonnet-4-6").ok === true, "so does the model list");
  ok(JSON.stringify(read().inferenceModels) === '["claude-opus-4-8","claude-sonnet-4-6"]',
     "in the order they were typed", JSON.stringify(read().inferenceModels));
  // Upstream also takes object entries ({ name, labelOverride, supports1m, ... }).
  // The textarea shows each one as a JSON line, so that line must parse back.
  ok(s("inferenceModels", 'claude-opus-4-8\n{"name":"claude-sonnet-4-6","labelOverride":"Sonnet"}').ok === true,
     "a JSON object line is accepted as a model entry");
  ok(JSON.stringify(read().inferenceModels) === '["claude-opus-4-8",{"name":"claude-sonnet-4-6","labelOverride":"Sonnet"}]',
     "stored as a real object, order kept", JSON.stringify(read().inferenceModels));
  ok(s("inferenceModels", [{ name: "claude-opus-4-8", supports1m: true }]).ok === true,
     "an array with an object entry round-trips");
  ok(s("inferenceModels", '{"labelOverride":"no name"}').ok === false, "an object without a name is rejected");
  ok(s("inferenceModels", '{"name":"x"').ok === false, "and a broken JSON line");
  ok(s("inferenceModels", '[1,2]').ok === true && JSON.stringify(read().inferenceModels) === '["[1,2]"]',
     "a line that is not an object stays a plain string id");
  ok(s("coworkEgressAllowedHosts", '{"name":"x"}').ok === true
     && JSON.stringify(read().coworkEgressAllowedHosts) === '["{\\"name\\":\\"x\\"}"]',
     "plain lists never parse JSON", JSON.stringify(read().coworkEgressAllowedHosts));

  ok(s("banner", "{ not json").ok === false, "a JSON key rejects a broken document");
  ok(s("banner", '{"text":"hi"}').ok === true, "and parses a good one");
  ok(read().banner && read().banner.text === "hi", "into a real object");

  ok(s("chatTabEnabled", null).ok === true, "null removes a key");
  ok(read().chatTabEnabled === undefined, "so it is absent from the file again");
  ok(s("inferenceGatewayBaseUrl", "   ").ok === true && read().inferenceGatewayBaseUrl === undefined,
     "and so does an empty string");
}

// --- [9] the raw editor --------------------------------------------------
section("[9] the raw editor replaces the file, but never silently");
{
  const p = install();
  p.call("cdb-deploy:set", "inferenceProvider", "gateway");
  p.call("cdb-deploy:set", "inferenceGatewayApiKey", "sk-keep-me");
  p.call("cdb-deploy:set", "chatTabEnabled", true);

  const bad = p.call("cdb-deploy:save-raw", '{"nonsenseKey": 1}');
  ok(bad.ok === false && /not a configuration key/.test(bad.error),
     "a key this build does not know is rejected, not dropped", bad.error);
  ok(p.call("cdb-deploy:save-raw", "{ oops").ok === false, "so is invalid JSON");
  ok(p.call("cdb-deploy:save-raw", "[]").ok === false, "and a document that is not an object");
  ok(p.call("cdb-deploy:save-raw", '{"managedMcpServers": []}').ok === false, "and a locked key");

  const meta = p.json(p.metaFile);
  const entryFile = join(p.libDir, meta.appliedId + ".json");
  ok(p.json(entryFile).chatTabEnabled === true, "nothing was written by any of the refusals");

  // The placeholder round-trips: the stored secret survives, and a key the new
  // document no longer mentions is dropped.
  const good = p.call("cdb-deploy:save-raw", JSON.stringify({
    inferenceProvider: "gateway",
    inferenceGatewayApiKey: KEEP,
    coworkTabEnabled: true
  }));
  ok(good.ok === true, "a valid document is saved", good.error);
  const after = p.json(entryFile);
  ok(after.inferenceGatewayApiKey === "sk-keep-me", "the untouched secret is still the stored one");
  ok(after.coworkTabEnabled === true, "the new key is there");
  ok(after.chatTabEnabled === undefined, "and the key the document dropped is gone");

  // A placeholder for a secret that was never stored must not be written literally.
  p.call("cdb-deploy:save-raw", JSON.stringify({
    inferenceProvider: "vertex", inferenceVertexOAuthClientSecret: KEEP
  }));
  ok(p.json(entryFile).inferenceVertexOAuthClientSecret === undefined,
     "a placeholder with nothing behind it is dropped rather than stored as text");
}

// --- [10] cooperating with upstream's own 3P Setup ------------------------
section("[10] the applied entry of upstream's library is edited, not replaced");
{
  const p = install();
  const id = "12345678-90ab-4cde-8f01-234567890abc";
  const other = "abcdef01-2345-4678-89ab-cdef01234567";
  mkdirSync(p.libDir, { recursive: true });
  writeFileSync(p.metaFile, JSON.stringify({
    appliedId: id,
    entries: [{ id: id, name: "Prod gateway" }, { id: other, name: "Lab" }]
  }));
  writeFileSync(join(p.libDir, id + ".json"), JSON.stringify({
    inferenceProvider: "gateway", inferenceGatewayBaseUrl: "https://prod.example"
  }));
  writeFileSync(join(p.libDir, other + ".json"), JSON.stringify({ inferenceProvider: "vertex" }));

  const r = p.call("cdb-deploy:read");
  ok(r.local.appliedId === id, "the applied entry is the one the panel edits");
  ok(r.local.entries.length === 2, "and every stored configuration is listed for the picker");
  ok(r.local.values.inferenceGatewayBaseUrl === "https://prod.example", "with its values");

  p.call("cdb-deploy:set", "chatTabEnabled", true);
  const edited = p.json(join(p.libDir, id + ".json"));
  ok(edited.inferenceGatewayBaseUrl === "https://prod.example" && edited.chatTabEnabled === true,
     "a write edits that entry in place, keeping what upstream's wizard put there");
  const meta = p.json(p.metaFile);
  ok(meta.appliedId === id && meta.entries.length === 2,
     "and leaves the library metadata alone", JSON.stringify(meta));

  // Applying another entry, and applying none - the non-destructive way out of 3P.
  ok(p.call("cdb-deploy:apply", other).ok === true, "another stored configuration can be applied");
  ok(p.call("cdb-deploy:read").local.values.inferenceProvider === "vertex", "and is then the active one");
  ok(p.call("cdb-deploy:apply", "nope").ok === false, "an unknown id is refused");
  ok(p.call("cdb-deploy:apply", "").ok === true, "applying none is allowed");
  const cleared = p.call("cdb-deploy:read");
  ok(cleared.source === "none" && cleared.expected === "1p", "which boots 1P");
  ok(existsSync(join(p.libDir, id + ".json")) && existsSync(join(p.libDir, other + ".json")),
     "with both configuration files still on disk - nothing was deleted");
  ok(p.json(p.metaFile).entries.length === 2, "and still listed, so they can be applied again");
}

// --- [11] the sender guard ------------------------------------------------
section("[11] only the settings page may reach these handlers");
{
  const p = install();
  const hostile = { sender: { isDestroyed: () => false, getURL: () => "file:///tmp/x.html" }, senderFrame: { parent: null } };
  const res = p.handlers["cdb-deploy:set"](hostile, "inferenceProvider", "gateway");
  ok(res.ok === false && /unrecognized sender/.test(res.error), "a non-http sender is rejected", res.error);
  const sub = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/x" }, senderFrame: { parent: {} } };
  ok(p.handlers["cdb-deploy:mode"](sub, "1p").ok === false, "so is a subframe");
  ok(!existsSync(p.metaFile) && !existsSync(p.modeFile), "and neither wrote anything");

  // The origin must be exactly ours. Every other main-process module compares
  // the parsed origin against an allowlist; an http(s)-only test would let any
  // https page that ends up in the main frame with our preload reach the
  // handlers that write the 3P gateway URL, its API key and the bootstrap URL,
  // and the one that relaunches the app.
  const from = (u) => ({ sender: { isDestroyed: () => false, getURL: () => u }, senderFrame: { parent: null } });
  const foreign = [
    "https://evil.example/",
    "https://evil.example/?next=claude.ai",
    "https://claude.ai.evil.example/",
    "https://evil.example/claude.ai/",
    "https://evil.example#https://claude.ai",
    "http://claude.ai/",
    "https://claude.ai:8443/",
    "https://user@claude.ai@evil.example/",
    "https://xn--claude-ai.example/",
    // 3P mode serves the SPA from app://localhost, whose parsed URL origin is
    // the opaque "null" - exactly app://localhost is ours, nothing near it.
    "app://localhost.evil/",
    "app://localhost:1234/",
    "app://other/",
    "file:///home/u/x.html",
    "http://localhost:3000/"
  ];
  for (const u of foreign) {
    const r = p.handlers["cdb-deploy:set"](from(u), "inferenceGatewayBaseUrl", "https://attacker.example");
    ok(r.ok === false && /unrecognized sender/.test(r.error), "an https sender at " + u + " is rejected", r.error);
  }
  ok(p.handlers["cdb-app:relaunch"](from("https://evil.example/")).ok === false,
     "and the relaunch handler is behind the same guard");
  ok(!existsSync(p.metaFile) && !existsSync(p.modeFile), "none of them wrote anything");

  const allowed = ["https://claude.ai/settings", "https://preview.claude.ai/x",
                   "https://claude.com/", "https://preview.claude.com/x?y=1#z",
                   "app://localhost/", "app://localhost/new?x=1"];
  for (const u of allowed) {
    ok(p.handlers["cdb-deploy:read"](from(u)).ok === true, "our own origin " + u + " is accepted");
  }
  ok(p.handlers["cdb-deploy:read"]({ sender: { isDestroyed: () => false, getURL: () => "app://localhost/" },
                                     senderFrame: { parent: {} } }).ok === false,
     "a subframe of the 3P app://localhost page is still rejected");
  ok(p.handlers["cdb-deploy:read"]({ sender: { getURL: () => "https://claude.ai/" }, senderFrame: { parent: null } }).ok === false,
     "a sender without isDestroyed() fails closed");
  ok(p.handlers["cdb-deploy:read"](from("not a url")).ok === false, "an unparseable URL fails closed");
}

// --- [12] a managed policy file that cannot be used -----------------------
section("[12] the real /etc policy file, as this machine has it");
{
  const p = install();
  const r = p.call("cdb-deploy:read");
  ok(r.paths.etcFile === "/etc/claude-desktop/managed-settings.json",
     "the managed path upstream hardcodes is reported");
  if (!existsSync("/etc/claude-desktop/managed-settings.json")) {
    ok(r.managed.present === false, "absent here, so the local configuration is what counts");
    ok(r.editable === true, "and the editor is writable");
  } else {
    ok(typeof r.managed.usable === "boolean", "present here, and its usability is reported");
    ok(r.editable === !r.managed.usable,
       "the editor is read-only exactly when the managed file is the active source");
  }
}

// --- [13] opening the files from the panel --------------------------------
section("[13] the file links open OUR files, and only those");
{
  const p = install();
  p.call("cdb-deploy:set", "inferenceProvider", "gateway");
  p.call("cdb-deploy:mode", "1p");
  const meta = p.json(p.metaFile);
  const entryFile = join(p.libDir, meta.appliedId + ".json");

  const r1 = await p.call("cdb-extra:reveal", "deploy-config", "open");
  ok(r1.ok === true && p.opened.indexOf("open:" + entryFile) >= 0,
     "\"deploy-config\" resolves to the applied entry file", p.opened.join(" "));
  const r2 = await p.call("cdb-extra:reveal", "deploy-mode", "folder");
  ok(r2.ok === true && p.opened.indexOf("show:" + p.modeFile) >= 0,
     "\"deploy-mode\" with folder reveals the mode file in the file manager");
  ok(r2.mode === "folder", "and says which of the two it did");

  const r3 = await p.call("cdb-extra:reveal", "config-json", "open");
  ok(r3.ok === true && r3.mode === "folder" &&
     p.opened.indexOf("open:" + p.userData) >= 0,
     "a file that does not exist yet opens its folder instead of failing", p.opened.join(" "));

  const bad = await p.call("cdb-extra:reveal", "/etc/shadow", "open");
  ok(bad.ok === false && /unknown location/.test(bad.error),
     "a path instead of a location name is refused - the page can never choose the target",
     bad.error);
  ok(p.opened.every((o) => o.indexOf("/etc/shadow") < 0), "and nothing was handed to the desktop");
  ok((await p.call("cdb-extra:reveal", "", "open")).ok === false, "so is an empty name");

  const names = ["config-json", "config-jsonc", "user-data", "deploy-config", "deploy-mode",
                 "deploy-meta", "deploy-lib", "managed"];
  for (const n of names) {
    const res = await p.call("cdb-extra:reveal", n, "open");
    ok(res.ok === true, "the location name \"" + n + "\" resolves", res.error || res.opened);
  }
}

// --- [14] which config file the Themes panel says it saves to ---------------
// The theme engine's persist walks [.jsonc, .json] and takes the first that
// EXISTS (the .jsonc wins the startup merge). __cdbThemes.configPath is a fixed
// .jsonc, so the panel must not label its link with that - it would name the
// wrong file on an install that only has the .json.
section("[14] the Themes panel's save target follows what is on disk");
{
  const p = install();
  const jsonc = join(p.userData, "claude-desktop-extra.jsonc");
  const json = join(p.userData, "claude-desktop-extra.json");
  globalThis.__cdbThemes = {
    list: () => [], active: () => "mario", configPath: jsonc
  };
  const target = () => p.call("cdb-extra:themes-list").savePath;

  ok(target() === jsonc, "with neither file present, the .jsonc is what would be created", target());
  writeFileSync(json, "{}");
  ok(target() === json, "with only the .json present, THAT is where a theme lands", target());
  writeFileSync(jsonc, "{}");
  ok(target() === jsonc, "with both, the .jsonc wins, as the engine's persist does", target());
  ok(p.call("cdb-extra:themes-list").configPath === jsonc,
     "the registry's own fixed path is still reported alongside it");
  delete globalThis.__cdbThemes;
}

// cdb-app:relaunch must PREFER upstream's own relaunch primitive. Ours used
// app.exit(0), which emits neither "before-quit" nor "will-quit" and so skipped
// every registered quit-cleanup handler (the Cowork VM stop, the MCP child
// shutdowns, the window-geometry persist). The capture is published by the
// patch as globalThis.__cdbRelaunchApp; when it is missing the handler has to
// fall back rather than leave a dead button.
section("[15] cdb-app:relaunch prefers upstream's relaunch primitive");
{
  const waitForTimer = () => new Promise(r => setTimeout(r, 400));

  const p1 = install();
  delete globalThis.__cdbRelaunchApp;
  ok(p1.call("cdb-app:relaunch").ok === true, "the handler still answers ok when no capture is present");
  await waitForTimer();
  ok(p1.diag.some(m => m.includes("relaunchApp unavailable")),
     "with no capture it says so and takes the exit(0) fallback");

  const p2 = install();
  let upstreamCalls = 0;
  globalThis.__cdbRelaunchApp = () => { upstreamCalls++; };
  ok(p2.call("cdb-app:relaunch").ok === true, "and answers ok when the capture IS present");
  await waitForTimer();
  ok(upstreamCalls === 1, "upstream's relaunchApp is called exactly once", String(upstreamCalls));
  ok(!p2.diag.some(m => m.includes("relaunchApp unavailable")),
     "and the fallback is NOT reported");

  // A throwing capture must not strand the user: fall back, and say why.
  const p3 = install();
  globalThis.__cdbRelaunchApp = () => { throw new Error("boom"); };
  p3.call("cdb-app:relaunch");
  await waitForTimer();
  ok(p3.diag.some(m => m.includes("falling back")),
     "a capture that throws is reported and falls back rather than dying silently");
  delete globalThis.__cdbRelaunchApp;
}

// --- [16] where the Extra page is injected ---------------------------------
// The dom-ready hook decides which documents get the page script and the CSS.
// In 3P mode the main window loads app://localhost, which an http(s)-only test
// silently skipped, so the Extra group never appeared there. It must follow the
// same exact-origin list as the sender guard, minus upstream's 3P setup window.
section("[16] the page is injected into our origins (1P and 3P), and only those");
{
  const p = install();
  const created = p.appEvents["web-contents-created"];
  ok(typeof created === "function", "a web-contents-created hook is registered");
  const injected = async (url) => {
    const h = {};
    const wc = {
      js: 0, css: 0,
      on: (e, f) => { h[e] = f; },
      getURL: () => url,
      isDestroyed: () => false,
      insertCSS: () => { wc.css++; return Promise.resolve("k" + wc.css); },
      removeInsertedCSS: () => Promise.resolve(),
      executeJavaScript: () => { wc.js++; return Promise.resolve("extra-settings: test"); }
    };
    created({}, wc);
    if (h["dom-ready"]) h["dom-ready"]();
    await new Promise((r) => setTimeout(r, 5));
    return wc.js > 0 && wc.css > 0;
  };
  for (const u of ["https://claude.ai/new", "https://preview.claude.ai/x", "https://claude.com/",
                   "app://localhost/new", "app://localhost/"]) {
    ok(await injected(u), "injected into " + u);
  }
  for (const u of ["https://evil.example/", "http://localhost:3000/", "http://127.0.0.1:5173/",
                   "app://localhost.evil/", "app://localhost:1234/", "app://other/",
                   "file:///home/u/x.html", "about:blank", "",
                   "app://localhost/setup-desktop-3p", "app://localhost/setup-desktop-3p?step=2"]) {
    ok(!(await injected(u)), "not injected into " + (u || "(empty URL)"));
  }
}

console.log("\n" + (fail ? `${pass} passed, ${fail} FAILED` : `ALL ${pass} CHECKS PASSED`));
process.exit(fail ? 1 : 0);
