#!/usr/bin/env node
// Computer Use on Linux: a per-call organization compliance deny, at parity
// with upstream's handleToolCall preamble.
//
// WHY THIS EXISTS
// ---------------
// Claude Desktop v1.46388.2 added a HIPAA/compliance check to the START of the
// Computer Use server's handleToolCall: when the org is restricted, every tool
// call answers `{isError:!0,content:[{type:"text",text:<message>}]}` before any
// executor runs. Our Linux dispatch (js/cu_handler_injection.js, injected by
// sub-patch 6 of fix_computer_use_linux.nim) is placed BEFORE that preamble and
// returns from it, so without a check of its own a compliance flip mid-session
// would keep working on X11 / GNOME / wlroots. Sub-patch 11 publishes upstream's
// gate function as `globalThis.__cdbCuHipaa`; the injection re-checks it.
//
// This harness loads the real js/cu_handler_injection.js the way the Nim patch
// stages it (placeholders substituted, the KDE gate applied) around a fake
// executor and pins:
//
//   1. RESTRICTED => DENIED. With __cdbCuHipaa() true, a tool call returns
//      isError with upstream's exact message, the executor is never reached,
//      and the denial is logged through the __cdbDiag sink.
//   2. NOT RESTRICTED => UNCHANGED. With __cdbCuHipaa() false, or with the
//      global unset (older bundle shapes have no HIPAA gate to capture), the
//      call reaches the executor exactly as before.
//   3. KDE WAYLAND IS UPSTREAM'S. With __cuKwinMode set the whole Linux block
//      is skipped, so upstream's own preamble stays the one that denies.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const INJECTION = join(ROOT, "js", "cu_handler_injection.js");

// Upstream's literal (v1.46388.2, `yhn=` in the CU module). If Anthropic rewords
// it, update js/cu_handler_injection.js and this constant together.
const UPSTREAM_MESSAGE =
  "Computer Use isn't available under your organization's compliance settings. " +
  "If you recently switched organizations, restart the app.";

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { failures.push(msg); console.log("  FAIL " + msg); }
}

// --- the rig ------------------------------------------------------------------
// Mirror what sub-patch 6 does to the snippet: substitute the five placeholders
// and widen the outer gate with the KDE (kwin-wayland) escape hatch. The result
// is the body of an async arrow `(toolName, input, session) => { ... }`; what
// follows the injected block in the real bundle is upstream's preamble, stood in
// for here by a sentinel return so a fall-through is observable.
const FELL_THROUGH = { fellThrough: true };
function buildHandler() {
  let src = readFileSync(INJECTION, "utf8").trim();
  src = src.replace("__SELF__", "__self");
  src = src.replace("__DISPATCHER__", "__dispatcher");
  src = src.split("__TOOL_NAME__").join("__tool");
  src = src.split("__INPUT__").join("__input");
  src = src.split("__SESSION__").join("__session");
  const gated = src.replace(
    'if(process.platform==="linux"){',
    'if(process.platform==="linux"&&!globalThis.__cuKwinMode){'
  );
  if (gated === src) throw new Error("harness: the outer Linux gate line moved; update the rig");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // eslint-disable-next-line no-new-func
  const fn = new AsyncFunction(
    "process", "__self", "__dispatcher", "__tool", "__input", "__session", "__FELL",
    gated + "\nreturn __FELL;"
  );
  const fakeProcess = { platform: "linux", env: process.env };
  return (tool, input, session) =>
    fn(fakeProcess, {}, () => async () => ({ content: [] }), tool, input || {}, session || {}, FELL_THROUGH);
}

function makeRig({ hipaa, kwin = false } = {}) {
  const calls = [];
  const diag = [];
  const executor = {
    getCursorPosition: async () => { calls.push("getCursorPosition"); return { x: 12, y: 34 }; },
    readClipboard: async () => { calls.push("readClipboard"); return "clip"; },
    writeClipboard: async () => { calls.push("writeClipboard"); },
    click: async () => { calls.push("click"); },
    screenshot: async () => { calls.push("screenshot"); return { base64: "AA==", mimeType: "image/jpeg", width: 1, height: 1 }; },
    listDisplays: async () => { calls.push("listDisplays"); return []; }
  };
  const saved = {};
  const set = (k, v) => { saved[k] = Object.prototype.hasOwnProperty.call(globalThis, k) ? globalThis[k] : undefined; if (v === undefined) delete globalThis[k]; else globalThis[k] = v; };
  set("__linuxExecutor", executor);
  set("__cdbDiag", (m) => diag.push(String(m)));
  set("__cuKwinMode", kwin);
  set("__cdbCuHipaa", hipaa);
  set("__cuLastShot", undefined);
  set("__cuActiveOrigin", undefined);
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
    }
  };
  return { handler: buildHandler(), calls, diag, restore };
}

const isDenial = (r) =>
  r && r.isError === true && Array.isArray(r.content) && r.content.length === 1 &&
  r.content[0].type === "text" && r.content[0].text === UPSTREAM_MESSAGE;

// --- 1. restricted => denied before the executor -----------------------------
async function testRestrictedDenies() {
  console.log("\n[1] a restricted org denies every tool call before the executor runs");
  let hipaaCalls = 0;
  const rig = makeRig({ hipaa: () => { hipaaCalls++; return true; } });
  try {
    const r = await rig.handler("cursor_position", {}, { sessionId: "s1" });
    ok(isDenial(r), "cursor_position answers isError with upstream's exact message: " + JSON.stringify(r).slice(0, 90));
    ok(rig.calls.length === 0, "and the executor was never reached: " + JSON.stringify(rig.calls));
    ok(hipaaCalls === 1, "the gate was consulted exactly once for the call, was " + hipaaCalls);
    ok(rig.diag.some((l) => l.includes("[claude-cu] tool call denied")),
       "the denial is logged through __cdbDiag: " + JSON.stringify(rig.diag));

    // request_access is answered inside the injection without an executor, so it
    // is the call most likely to slip past a check placed too low.
    rig.calls.length = 0;
    const r2 = await rig.handler("request_access", { apps: ["Files"] }, {});
    ok(isDenial(r2), "request_access (no-executor path) is denied too");
    const r3 = await rig.handler("write_clipboard", { text: "x" }, {});
    ok(isDenial(r3) && rig.calls.length === 0, "write_clipboard is denied and the clipboard untouched");
    ok(r !== FELL_THROUGH && r2 !== FELL_THROUGH, "denials return from OUR block, they do not fall through to upstream");
  } finally { rig.restore(); }
}

// --- 2. not restricted => the executor path is unchanged ---------------------
async function testUnrestrictedPasses() {
  console.log("\n[2] an unrestricted org reaches the executor as before");
  const rig = makeRig({ hipaa: () => false });
  try {
    const r = await rig.handler("cursor_position", {}, {});
    ok(rig.calls.includes("getCursorPosition"), "cursor_position reached the executor: " + JSON.stringify(rig.calls));
    ok(r && !r.isError && r.content[0].text === "(12, 34)", "and answered with the cursor position: " + JSON.stringify(r));
    ok(rig.diag.length === 0, "nothing was logged as denied: " + JSON.stringify(rig.diag));
    const r2 = await rig.handler("read_clipboard", {}, {});
    ok(r2 && r2.content[0].text === "clip", "read_clipboard answers the clipboard text");
  } finally { rig.restore(); }
}

async function testGateUnsetPasses() {
  console.log("\n[3] with no published gate (older bundle shape) the check is skipped");
  const rig = makeRig({ hipaa: undefined });
  try {
    ok(typeof globalThis.__cdbCuHipaa === "undefined", "precondition: __cdbCuHipaa is not defined");
    const r = await rig.handler("cursor_position", {}, {});
    ok(rig.calls.includes("getCursorPosition") && r.content[0].text === "(12, 34)",
       "cursor_position reached the executor: " + JSON.stringify(r));
    ok(rig.diag.length === 0, "and nothing was logged as denied");
  } finally { rig.restore(); }
}

// --- 3. KDE Wayland leaves the deny to upstream --------------------------------
async function testKwinFallsThrough() {
  console.log("\n[4] under kwin-wayland the Linux block is skipped, upstream's preamble decides");
  let hipaaCalls = 0;
  const rig = makeRig({ hipaa: () => { hipaaCalls++; return true; }, kwin: true });
  try {
    const r = await rig.handler("cursor_position", {}, {});
    ok(r === FELL_THROUGH, "the call fell through to upstream's handler");
    ok(hipaaCalls === 0 && rig.calls.length === 0, "our block consulted neither the gate nor the executor");
  } finally { rig.restore(); }
}

async function main() {
  try {
    await testRestrictedDenies();
    await testUnrestrictedPasses();
    await testGateUnsetPasses();
    await testKwinFallsThrough();
  } catch (e) {
    console.error("\nHARNESS ERROR: " + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
  console.log("");
  if (failures.length) {
    console.log("FAILED " + failures.length + " of " + (pass + failures.length) + " checks:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
}

main();
