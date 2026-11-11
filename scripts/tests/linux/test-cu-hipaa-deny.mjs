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

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

// --- [5] the managed computerUseEnabled key on the patched gate -------------
// v5.1231.0 added the managed `computerUseEnabled` key (an admin switch) to
// the enable gate on every platform:
//   function EW(e={}){return!SW()||!_W()||bb()?!1:TW(e)&&ub("chicagoEnabled")}
// Sub-patch 11's Linux branch forces the platform/rollout/chicagoEnabled parts
// but must keep that key: `computerUseEnabled:false` turns CU off on Linux,
// unset keeps our Linux behavior. Sub-patch 12 (the registerable gate) must
// delegate to that gate. This section patches the real bundle and runs both
// gate functions with the key and the HIPAA gate stubbed. Skipped when the
// patch binary or the extract is missing.
// Source of the function whose definition starts at `start` (balanced braces).
function fnSourceAt(s, start) {
  if (start < 0) return null;
  let depth = 0, q = null;
  // The body opens at the first `){` (a default `e={}` parameter has braces too).
  for (let i = s.indexOf("){", start) + 1; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}
function testManagedComputerUseEnabled() {
  console.log("\n[5] managed computerUseEnabled:false turns Computer Use off on Linux (sub-patches 11 + 12)");
  const bin = process.env.CDB_CU_PATCH_BIN || join(ROOT, "patches", "linux", "fix_computer_use_linux");
  const build = join(process.env.CDB_BUNDLE_DIR || join(ROOT, "tmp", "app.asar.contents"), ".vite", "build");
  try { accessSync(bin, constants.X_OK); } catch { console.log("  SKIP " + bin + " is not compiled"); return; }
  if (!existsSync(join(build, "index.js"))) { console.log("  SKIP no extract under tmp/app.asar.contents/"); return; }
  let blob = readFileSync(join(build, "index.js"), "utf8");
  for (const c of readdirSync(build).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort()) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(join(build, c), "utf8");
  const PRISTINE_RE = /function ([\w$]+)\(([\w$]+)=\{\}\)\{return![\w$]+\(\)\|\|!([\w$]+)\(\)\|\|([\w$]+)\(\)\?!1:[\w$]+\(\2\)&&[\w$]+\(["`]chicagoEnabled["`]\)\}/;
  const pm = PRISTINE_RE.exec(blob);
  if (!pm) {
    // Older bundles (before v5.1231.0) have no managed key in the gate.
    console.log("  SKIP this bundle's enable gate has no managed computerUseEnabled check (pre-v5.1231.0 shape)");
    return;
  }
  const [, gate, , managed, hipaa] = pm;
  ok(new RegExp("function " + managed.replace(/\$/g, "\\$") + "\\(\\)\\{return [^{}]{0,120}\\|\\|([\\w$]+)\\(\\)!==!1\\}").test(blob),
    `pristine: ${managed}() ends in the managed-key reader (\`||R()!==!1\`)`);
  const scratch = mkdtempSync(join(tmpdir(), "cdb-cu-managed-"));
  try {
    const staged = join(scratch, "staged.js");
    writeFileSync(staged, blob);
    const r = spawnSync(bin, [staged], { encoding: "utf8" });
    ok(r.status === 0, "patch binary exits 0");
    const patched = readFileSync(staged, "utf8");
    // Minified names repeat across chunks: locate by the Linux branch itself.
    const gateAt = patched.indexOf("function " + gate + "(e={}){if(process.platform===\"linux\")return globalThis.__cdbCuHipaa=");
    const gateSrc = gateAt < 0 ? null : fnSourceAt(patched, gateAt);
    ok(gateSrc && gateSrc.includes(`if(process.platform==="linux")return globalThis.__cdbCuHipaa=${hipaa},!${hipaa}()&&${managed}();`),
      `sub-patch 11: the Linux branch of ${gate}() keeps ${managed}() and ${hipaa}()`);
    const REG_RE = new RegExp("function ([\\w$]+)\\(([\\w$]+)=\\{\\}\\)\\{if\\(process\\.platform===\"linux\"\\)return " + gate.replace(/\$/g, "\\$") + "\\(\\2\\);");
    const rm = REG_RE.exec(patched);
    ok(!!rm, `sub-patch 12: the registerable gate delegates to ${gate}() on Linux`);
    const regSrc = rm ? fnSourceAt(patched, rm.index) : null;
    // Run the real patched functions; every other name is "on" so only the
    // two stubs decide.
    const run = (platform, managedVal, hipaaVal, which) => {
      const on = () => true;
      const scope = new Proxy({ process: { platform }, globalThis: {}, [managed]: () => managedVal, [hipaa]: () => hipaaVal }, {
        has: (o, k) => typeof k === "string" && k !== gate && (rm ? k !== rm[1] : true),
        get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : on),
      });
      const fns = new Function("__scope", "with(__scope){" + gateSrc + "\n" + (regSrc || "") + "\nreturn{gate:" + gate + (rm ? ",reg:" + rm[1] : "") + "}}")(scope);
      return fns[which]({});
    };
    if (gateSrc) {
      ok(run("linux", false, false, "gate") === false, "linux, computerUseEnabled:false -> isComputerUseEnabled false");
      ok(run("linux", true, false, "gate") === true, "linux, key unset (reader !== false) -> isComputerUseEnabled true (our Linux behavior)");
      ok(run("linux", true, true, "gate") === false, "linux, HIPAA restricted -> false");
      ok(run("darwin", false, false, "gate") === false, "darwin, computerUseEnabled:false -> false (upstream)");
    }
    if (regSrc) {
      ok(run("linux", false, false, "reg") === false, "linux, computerUseEnabled:false -> isComputerUseRegisterable false");
      ok(run("linux", true, false, "reg") === true, "linux, key unset -> isComputerUseRegisterable true");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  try {
    await testRestrictedDenies();
    await testUnrestrictedPasses();
    await testGateUnsetPasses();
    await testKwinFallsThrough();
    testManagedComputerUseEnabled();
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
