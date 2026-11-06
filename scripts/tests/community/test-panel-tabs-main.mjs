#!/usr/bin/env node
/*
 * test-panel-tabs-main.mjs - the main-process half of the panel tabs feature.
 * A clean patch run says nothing about WHICH file the pref is written to or
 * whether a .jsonc lock wins, so this suite runs the real module with electron
 * shimmed and a temporary profile dir. Exit 3 = a required tool is missing.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

// getPath: pass a string for a real profile dir, or null to simulate no
// userData path at all (electron.app.getPath throwing, e.g. before ready).
// app.on listeners of the LAST load(), so the dom-ready injection can be driven.
let appListeners = {};
function load(profileDir) {
  const handlers = {};
  appListeners = {};
  const electron = {
    app: {
      getPath: () => { if (profileDir === null) throw new Error("no app"); return profileDir; },
      on: (ev, fn) => { (appListeners[ev] = appListeners[ev] || []).push(fn); }
    },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }
  };
  const src = readFileSync(join(ROOT, "js/panel_tabs_main.js"), "utf8")
    .replace('"__CDB_TABS_PAGE_SRC__"', '"/*page*/"');
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env: {} }, console, globalThis: {}, setTimeout };
  sandbox.globalThis = sandbox;
  { const __c = vm.createContext(sandbox);
    vm.runInContext(readFileSync(new URL("../../../js/sender_guard.js", import.meta.url), "utf8"), __c);
    vm.runInContext(src, __c); }
  return handlers;
}

// A real webContents always has isDestroyed(); okSender must fail CLOSED if
// it is ever missing (Finding 3), so every fake sender below carries one.
function sender(url) { return { sender: { getURL: () => url, isDestroyed: () => false } }; }
const okSenderEv = sender("https://claude.ai/epitaxy");

{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-"));
  const h = load(dir);
  ok(typeof h["cdb-tabs:state"] === "function", "registers cdb-tabs:state");
  ok(typeof h["cdb-tabs:pref-read"] === "function", "registers cdb-tabs:pref-read");
  ok(typeof h["cdb-tabs:pref-set"] === "function", "registers cdb-tabs:pref-set");

  const initial = await h["cdb-tabs:pref-read"](okSenderEv);
  ok(initial.ok === true && initial.enabled === false, "pref defaults to off (opt-in)");

  const set = await h["cdb-tabs:pref-set"](okSenderEv, true);
  ok(set.ok === true && set.enabled === true, "pref-set turns the feature on");
  const after = await h["cdb-tabs:pref-read"](okSenderEv);
  ok(after.enabled === true, "pref survives a re-read from disk");
  const st = await h["cdb-tabs:state"](okSenderEv);
  ok(st.ok === true && st.enabled === true, "state reports the pref");

  const bad = await h["cdb-tabs:pref-set"](okSenderEv, "yes");
  ok(bad.ok === false, "pref-set rejects a non-boolean");

  // (a) WHICH FILE the pref landed in: read claude-desktop-extra.json back
  // directly. An implementation that (mistakenly) wrote the .jsonc instead
  // would pass every check above while failing this one.
  const onDisk = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(onDisk.panelTabs === true, "pref-set actually wrote claude-desktop-extra.json");

  // (e) pref-set(false) round-trips, and going back to the default value
  // removes the key entirely rather than writing `"panelTabs": false`.
  const off = await h["cdb-tabs:pref-set"](okSenderEv, false);
  ok(off.ok === true && off.enabled === false, "pref-set(false) turns the feature back off");
  const offDisk = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(!("panelTabs" in offDisk), "setting back to the default removes the key rather than writing false");

  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"),
    '{\n  // locked by the operator\n  "panelTabs": false\n}\n');
  // A .json also exists while the .jsonc holds the lock - it must come out
  // byte-for-byte unchanged after a refused pref-set (Finding 1 / gap c: a
  // "refuse but write anyway" bug would corrupt or touch this file).
  const jsonPath = join(dir, "claude-desktop-extra.json");
  const untouchedContent = '{\n  "someOtherExtra": "leave me alone"\n}\n';
  writeFileSync(jsonPath, untouchedContent);

  const h = load(dir);
  const read = await h["cdb-tabs:pref-read"](okSenderEv);
  ok(read.lockedByJsonc === true, "a .jsonc value reports lockedByJsonc");
  const set = await h["cdb-tabs:pref-set"](okSenderEv, true);
  ok(set.ok === false && /claude-desktop-extra\.jsonc/.test(set.error),
     "pref-set refuses while the .jsonc holds the key");
  ok(readFileSync(jsonPath, "utf8") === untouchedContent,
     "a refused (locked) pref-set does not touch the .json at all");
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-"));
  const h = load(dir);
  const res = await h["cdb-tabs:pref-set"](sender("https://evil.example"), true);
  ok(res.ok === false && /sender/.test(res.error), "rejects an unrecognised sender");
  rmSync(dir, { recursive: true, force: true });
}
// A naive "//"-strips-to-end-of-line .jsonc stripper corrupts any string value
// that happens to contain "//" without a preceding colon (e.g. a path, not a
// URL) - it is not enough to special-case "://". Guard against that class of
// bug directly, independent of whichever regex the implementation uses.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"),
    '{\n  "panelTabs": true,\n  "note": "see a//b for details"\n}\n');
  const h = load(dir);
  const read = await h["cdb-tabs:pref-read"](okSenderEv);
  ok(read.ok === true && read.enabled === true,
     ".jsonc/.json comment-stripping does not corrupt a string value containing //");
  rmSync(dir, { recursive: true, force: true });
}
// The sender check must compare the ORIGIN, not merely test whether the URL
// string contains "claude.ai"/"claude.com" as a substring - the latter would
// wave through a lookalike host that embeds the real domain as a path segment
// or subdomain label.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-"));
  const h = load(dir);
  const res = await h["cdb-tabs:pref-set"](sender("https://evil.example/?next=claude.ai"), true);
  ok(res.ok === false, "rejects a sender whose URL merely contains \"claude.ai\" as a substring");
  rmSync(dir, { recursive: true, force: true });
}
// (d) POSITIVE origin coverage: a typo that dropped three of the four
// allowlist entries would still pass every rejection test above. Assert each
// allowed origin is actually accepted.
{
  const allowedUrls = [
    "https://claude.ai/x",
    "https://preview.claude.ai/x",
    "https://claude.com/x",
    "https://preview.claude.com/x"
  ];
  for (const url of allowedUrls) {
    const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-"));
    const h = load(dir);
    const res = await h["cdb-tabs:state"](sender(url));
    ok(res.ok === true, "accepts an allowed sender origin: " + url);
    rmSync(dir, { recursive: true, force: true });
  }
}
// (b) sibling keys survive a write: another extra's key already in the .json
// must still be present after pref-set writes ours next to it.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-"));
  const jsonPath = join(dir, "claude-desktop-extra.json");
  writeFileSync(jsonPath, JSON.stringify({ customThemes: ["mine"], coworkGlow: true }, null, 2) + "\n");
  const h = load(dir);
  const set = await h["cdb-tabs:pref-set"](okSenderEv, true);
  ok(set.ok === true, "pref-set succeeds when sibling keys already exist");
  const disk = JSON.parse(readFileSync(jsonPath, "utf8"));
  ok(disk.panelTabs === true, "our key is present after the write");
  ok(JSON.stringify(disk.customThemes) === JSON.stringify(["mine"]) && disk.coworkGlow === true,
     "sibling keys (customThemes, coworkGlow) survive the write untouched");
  rmSync(dir, { recursive: true, force: true });
}
// Finding 1: an existing-but-unparseable .json must be REFUSED, not silently
// treated as empty and overwritten - the latter would wipe every other
// extra's settings while reporting success. Nothing may be written.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-"));
  const jsonPath = join(dir, "claude-desktop-extra.json");
  const broken = '{"customThemes":["mine"],"coworkGlow":true,"diffViews":true,"oops": ,}';
  writeFileSync(jsonPath, broken);
  const h = load(dir);
  const set = await h["cdb-tabs:pref-set"](okSenderEv, true);
  ok(set.ok === false, "pref-set refuses when the existing .json is not valid JSON");
  ok(readFileSync(jsonPath, "utf8") === broken,
     "an unparseable .json is left byte-for-byte unchanged - nothing was written");
  rmSync(dir, { recursive: true, force: true });
}
// (e) the no-userData-path failure mode: electron.app.getPath is unavailable
// (e.g. called before the app is ready). Reads fall back to the default;
// pref-set must fail explicitly instead of throwing or silently no-oping.
{
  const h = load(null);
  const read = await h["cdb-tabs:pref-read"](okSenderEv);
  ok(read.ok === true && read.enabled === false, "pref-read falls back to the default with no userData path");
  const set = await h["cdb-tabs:pref-set"](okSenderEv, true);
  ok(set.ok === false, "pref-set fails explicitly with no userData path, instead of throwing");
}

// --- THE TWO SENDER GUARDS, which had ZERO coverage -----------------------------
// Proven vacuous by a reviewer: deleting BOTH `wc.isDestroyed()` and the
// `senderFrame`/`frame.parent` subframe check left 28/28 passing, because every fake
// sender above carries an isDestroyed and no case ever built a destroyed sender, a
// sender missing the method, or a subframe sender. Both are security controls.
//
// Each variant below uses an ALLOWED origin, so the only thing that can reject it is
// the guard under test.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-main-guards-"));
  const h = load(dir);
  const CHANNELS = ["cdb-tabs:state", "cdb-tabs:pref-read", "cdb-tabs:pref-set"];

  // (a) a DESTROYED webContents - the window went away mid-flight.
  const destroyed = { sender: { getURL: () => "https://claude.ai/epitaxy", isDestroyed: () => true } };
  for (const ch of CHANNELS) {
    const res = await h[ch](destroyed, true);
    ok(res.ok === false && /unrecognized sender/.test(res.error || ""),
       "guard: " + ch + " rejects a DESTROYED sender, allowed origin notwithstanding");
  }

  // (b) isDestroyed MISSING entirely. This must fail CLOSED through the catch, not be
  //     read as "not destroyed" - the comment at panel_tabs_main.js:165 promises exactly
  //     that, and nothing tested it.
  const noMethod = { sender: { getURL: () => "https://claude.ai/epitaxy" } };
  for (const ch of CHANNELS) {
    const res = await h[ch](noMethod, true);
    ok(res.ok === false && /unrecognized sender/.test(res.error || ""),
       "guard: " + ch + " rejects a sender with NO isDestroyed - fail closed, never 'assume fine'");
  }

  // (c) a SUBFRAME sender: an iframe inside an allowed page must not reach these
  //     channels. `senderFrame.parent` is the discriminator.
  const subframe = { sender: { getURL: () => "https://claude.ai/epitaxy", isDestroyed: () => false },
    senderFrame: { parent: {} } };
  for (const ch of CHANNELS) {
    const res = await h[ch](subframe, true);
    ok(res.ok === false && /unrecognized sender/.test(res.error || ""),
       "guard: " + ch + " rejects a SUBFRAME sender even on an allowed origin");
  }

  // (d) and the guards must not have made the legitimate path unreachable: a top-level
  //     frame (senderFrame present, parent null) on an allowed origin still works.
  const topFrame = { sender: { getURL: () => "https://claude.ai/epitaxy", isDestroyed: () => false },
    senderFrame: { parent: null } };
  const okRes = await h["cdb-tabs:pref-read"](topFrame);
  ok(okRes.ok === true,
     "guard: a TOP-LEVEL frame on an allowed origin is still accepted - the checks reject subframes, not everything");

  // (e) pref-set specifically must not have written anything on any rejected call.
  const after = await h["cdb-tabs:pref-read"](okSenderEv);
  ok(after.ok === true && after.enabled === false,
     "guard: none of the rejected pref-set calls changed the stored pref");
}

// The sender guard is exact-origin. 3P mode serves the SPA from
// app://localhost, whose parsed origin is the opaque "null", so it has to be
// normalised before the compare - and nothing near it may slip through.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-tabs-3p-"));
  const h = load(dir);
  const from = (u, parent = null) => ({ sender: { getURL: () => u, isDestroyed: () => false }, senderFrame: { parent } });
  for (const u of ["https://claude.ai/x", "https://preview.claude.ai/x", "https://claude.com/",
                   "https://preview.claude.com/x", "app://localhost/", "app://localhost/new?x=1"]) {
    ok((await h["cdb-tabs:pref-read"](from(u))).ok === true, "sender " + u + " accepted");
  }
  for (const u of ["https://evil.example/", "app://localhost.evil/", "app://localhost:1234/", "app://other/",
                   "file:///home/u/x.html", "http://localhost:3000/", "http://claude.ai/", "not a url"]) {
    const r = await h["cdb-tabs:pref-read"](from(u));
    ok(r.ok === false && /unrecognized sender/.test(r.error || ""), "sender " + u + " rejected");
  }
  ok((await h["cdb-tabs:pref-read"](from("app://localhost/", {}))).ok === false,
     "an app://localhost subframe is rejected");
  // The page injection follows the same window: app://localhost gets the
  // page script, a lookalike app:// host does not.
  const injected = [];
  for (const u of ["app://localhost/new", "app://localhost.evil/", "app://other/", "app://localhost:1234/",
                   "app://localhost/setup-desktop-3p", "app://localhost/setup-desktop-3p/step?x=1"]) {
    const wc = { getURL: () => u, on: (ev, fn) => { if (ev === "dom-ready") fn(); },
      executeJavaScript: () => { injected.push(u); return Promise.resolve(); } };
    for (const fn of appListeners["web-contents-created"] || []) fn({}, wc);
  }
  ok(injected.length === 1 && injected[0] === "app://localhost/new",
     "page injected into app://localhost only, not lookalikes or the 3P setup wizard (got " + JSON.stringify(injected) + ")");
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
