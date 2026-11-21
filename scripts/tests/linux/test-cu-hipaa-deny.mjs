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
//   4. SSH HOST => DENIED (section [6]). Upstream's per-call "CLI on an SSH
//      host" deny, which Patch 6 mirrors after the HIPAA check: refused with
//      the flag on, passes with it off.
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
function buildHandler(ssh = null) {
  let src = readFileSync(INJECTION, "utf8").trim();
  // Patch 6 writes the per-call SSH-host deny in place of this marker; a rig
  // with `ssh` uses the statement the patch emitted into the real bundle.
  if (ssh) {
    if (src.split("/*__CDB_SSH_DENY__*/").length !== 2) throw new Error("harness: the SSH deny marker moved; update the rig");
    src = src.replace("/*__CDB_SSH_DENY__*/", ssh.stmt);
  }
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
  const extraNames = ssh ? Object.keys(ssh.scope) : [];
  const fn = new AsyncFunction(
    "process", "__self", "__dispatcher", "__tool", "__input", "__session", "__FELL", ...extraNames,
    gated + "\nreturn __FELL;"
  );
  const fakeProcess = { platform: "linux", env: process.env };
  return (tool, input, session) =>
    fn(fakeProcess, {}, () => async () => ({ content: [] }), tool, input || {}, session || {}, FELL_THROUGH, ...extraNames.map((k) => ssh.scope[k]));
}

function makeRig({ hipaa, kwin = false, ssh = null } = {}) {
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
  return { handler: buildHandler(ssh), calls, diag, restore };
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
  // v6.28899.2 added a fourth term, the server's allowed-apps gate
  // (`function lGr(){return!BWr()||zWr()&&ZD()}`): group 5. On Linux it fails
  // closed on every session: the branch requires `BWr()&&!zWr()` (readable,
  // no entry), because our Linux block does not enforce the list on X11.
  const PRISTINE_RE = /function ([\w$]+)\(([\w$]+)=\{\}\)\{return![\w$]+\(\)\|\|!([\w$]+)\(\)\|\|([\w$]+)\(\)(?:\|\|([\w$]+)\(\))?\?!1:[\w$]+\(\2\)&&[\w$]+\(["`]chicagoEnabled["`]\)\}/;
  const pm = PRISTINE_RE.exec(blob);
  if (!pm) {
    // Older bundles (before v5.1231.0) have no managed key in the gate. A bundle
    // that knows the key but not this shape is a moved gate, never a skip.
    if (/["`]computerUseEnabled["`]/.test(blob)) {
      ok(false, "the bundle reads the managed computerUseEnabled key, but the enable gate's shape is unknown - re-fit PRISTINE_RE (and sub-patch 11)");
      return;
    }
    console.log("  SKIP this bundle's enable gate has no managed computerUseEnabled check (pre-v5.1231.0 shape)");
    return;
  }
  const [, gate, , managed, hipaa, allow] = pm;
  // The allowed-apps gate's readers: R (readable), E (has an entry), W (Wayland).
  const am = allow && new RegExp("function " + allow.replace(/\$/g, "\\$") + "\\(\\)\\{return!([\\w$]+)\\(\\)\\|\\|([\\w$]+)\\(\\)&&([\\w$]+)\\(\\)\\}").exec(blob);
  if (allow) ok(!!am, `pristine: ${allow}() is \`return!R()||E()&&W()\``);
  const [, readable, hasEntry, wayland] = am || [];
  const allowTerm = am ? `&&${readable}()&&!${hasEntry}()` : "";
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
    ok(gateSrc && gateSrc.includes(`if(process.platform==="linux")return globalThis.__cdbCuHipaa=${hipaa},!${hipaa}()&&${managed}()${allowTerm};`),
      `sub-patch 11: the Linux branch of ${gate}() keeps ${managed}() and ${hipaa}()` + (am ? ` and fails closed on the allowed-apps list (${readable}() && !${hasEntry}())` : ""));
    // Upstream's own allowed-apps gate, from the gate's chunk part (names are
    // unique per chunk only), so darwin runs upstream's real rule.
    const partStart = gateAt < 0 ? -1 : patched.lastIndexOf("/*__CDB_SPLIT__", gateAt);
    const partEnd = gateAt < 0 ? -1 : patched.indexOf("/*__CDB_SPLIT__", gateAt);
    const gatePart = gateAt < 0 ? "" : patched.slice(Math.max(0, partStart), partEnd < 0 ? patched.length : partEnd);
    const allowAt = am ? gatePart.indexOf("function " + allow + "(){") : -1;
    const allowSrc = allowAt < 0 ? "" : fnSourceAt(gatePart, allowAt);
    if (am) ok(!!allowSrc, `upstream's ${allow}() is in the gate's chunk`);
    const REG_RE = new RegExp("function ([\\w$]+)\\(([\\w$]+)=\\{\\}\\)\\{if\\(process\\.platform===\"linux\"\\)return " + gate.replace(/\$/g, "\\$") + "\\(\\2\\);");
    const rm = REG_RE.exec(patched);
    ok(!!rm, `sub-patch 12: the registerable gate delegates to ${gate}() on Linux`);
    const regSrc = rm ? fnSourceAt(patched, rm.index) : null;
    // Run the real patched functions; every other name is "on" so only the
    // two stubs decide.
    // Run the real patched functions; every other name is "on" so only the
    // stubs decide. `list`: "none" (readable, no entry), "entry" (readable,
    // has an entry) or "unreadable".
    const run = (platform, managedVal, hipaaVal, which, { list = "none", wl = false } = {}) => {
      const on = () => true;
      const stubs = { process: { platform }, globalThis: {}, [managed]: () => managedVal, [hipaa]: () => hipaaVal };
      if (am) {
        stubs[readable] = () => list !== "unreadable";
        stubs[hasEntry] = () => list === "entry";
        stubs[wayland] = () => wl;
      }
      const scope = new Proxy(stubs, {
        has: (o, k) => typeof k === "string" && k !== gate && (rm ? k !== rm[1] : true) && k !== allow,
        get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : on),
      });
      const fns = new Function("__scope", "with(__scope){" + gateSrc + "\n" + (regSrc || "") + "\n" + (allowSrc || "") + "\nreturn{gate:" + gate + (rm ? ",reg:" + rm[1] : "") + "}}")(scope);
      return fns[which]({});
    };
    if (gateSrc) {
      ok(run("linux", false, false, "gate") === false, "linux, computerUseEnabled:false -> isComputerUseEnabled false");
      ok(run("linux", true, false, "gate") === true, "linux, key unset (reader !== false) -> isComputerUseEnabled true (our Linux behavior)");
      ok(run("linux", true, true, "gate") === false, "linux, HIPAA restricted -> false");
      ok(run("darwin", false, false, "gate") === false, "darwin, computerUseEnabled:false -> false (upstream)");
      if (am) {
        ok(run("linux", true, false, "gate", { list: "none" }) === true, "linux, no allowed-apps list -> on");
        ok(run("linux", true, false, "gate", { list: "entry", wl: false }) === false, "linux X11, the server sends an allowed-apps list -> off (fail closed: our block does not enforce it)");
        ok(run("linux", true, false, "gate", { list: "entry", wl: true }) === false, "linux Wayland, an allowed-apps list -> off (as upstream)");
        ok(run("linux", true, false, "gate", { list: "unreadable" }) === false, "linux, the list value unreadable -> off");
        ok(run("darwin", true, false, "gate", { list: "none" }) === true, "darwin, no list -> on (upstream unchanged)");
        ok(run("darwin", true, false, "gate", { list: "entry", wl: false }) === true, "darwin, a list off Wayland -> on (upstream's rule, unchanged)");
        ok(run("darwin", true, false, "gate", { list: "unreadable" }) === false, "darwin, the list value unreadable -> off (upstream)");
      }
    }
    if (regSrc) {
      ok(run("linux", false, false, "reg") === false, "linux, computerUseEnabled:false -> isComputerUseRegisterable false");
      ok(run("linux", true, false, "reg") === true, "linux, key unset -> isComputerUseRegisterable true");
      if (am) {
        ok(run("linux", true, false, "reg", { list: "entry" }) === false, "linux X11, an allowed-apps list -> isComputerUseRegisterable false (delegates)");
        ok(run("linux", true, false, "reg", { list: "unreadable" }) === false, "linux, list unreadable -> isComputerUseRegisterable false");
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- [6] the per-call SSH-host deny upstream's preamble runs (v6.28899.2) ---
// Upstream's handleToolCall starts with
//   if(t.ojt())return s(t.Y6);if(t.SV(i))return t.QHt.info(`[cu] ... deny (CLI
//   on an SSH host)`),s(st);
// with SV `function NRi(e){return e.cliOnSshHost===!0&&MRi()}` (GrowthBook
// 3699048477). Our Linux block returns before that preamble, so Patch 6 writes
// the same deny (same predicate, same session param, upstream's refusal text)
// right after our HIPAA check. This section patches the real bundle, takes the
// emitted statement and upstream's predicate from it, and runs the injection
// with the session's cliOnSshHost and the flag stubbed.
async function testSshHostDeny() {
  console.log("\n[6] a session whose CLI runs on an SSH host is refused per call (upstream's preamble, mirrored)");
  const bin = process.env.CDB_CU_PATCH_BIN || join(ROOT, "patches", "linux", "fix_computer_use_linux");
  const build = join(process.env.CDB_BUNDLE_DIR || join(ROOT, "tmp", "app.asar.contents"), ".vite", "build");
  try { accessSync(bin, constants.X_OK); } catch { console.log("  SKIP " + bin + " is not compiled"); return; }
  if (!existsSync(join(build, "index.js"))) { console.log("  SKIP no extract under tmp/app.asar.contents/"); return; }
  let blob = readFileSync(join(build, "index.js"), "utf8");
  const names = ["index.js"];
  for (const c of readdirSync(build).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort()) { blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(join(build, c), "utf8"); names.push(c); }
  if (!/deny \(CLI on an SSH host\)/.test(blob) || !/cliOnSshHost===!0&&/.test(blob)) { console.log("  SKIP this bundle has no per-call SSH-host deny (pre-v6.28899.2)"); return; }
  const scratch = mkdtempSync(join(tmpdir(), "cdb-cu-ssh-"));
  try {
    const staged = join(scratch, "staged.js");
    writeFileSync(staged, blob);
    const r = spawnSync(bin, [staged], { encoding: "utf8" });
    ok(r.status === 0, "patch binary exits 0");
    const patched = readFileSync(staged, "utf8");
    const parts = patched.split(/\n\/\*__CDB_SPLIT__[^*\n]+?__\*\/\n/);
    const STMT_RE = /\/\*__cdbSshDeny\*\/if\(([\w$]+)\.([\w$]+)\(([\w$]+)\)\)\{\(globalThis\.__cdbDiag\|\|console\.log\)\("[^"]*"\);return\{isError:!0,content:\[\{type:"text",text:([\w$]+)\}\]\}\}/;
    const pi = parts.findIndex((b) => STMT_RE.test(b));
    ok(pi >= 0 && parts.filter((b) => STMT_RE.test(b)).length === 1, "Patch 6 emitted the SSH-host deny once", pi >= 0 ? names[pi] : "");
    if (pi < 0) return;
    const part = parts[pi];
    const sm = STMT_RE.exec(part);
    const [stmt, ns, key, sess, textName] = sm;
    const hm = /handleToolCall:async\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)(?:,[\w$]+)?\)=>\{if\(process\.platform==="linux"&&!globalThis\.__cuKwinMode\)\{__cdbLx:\{/.exec(part);
    ok(!!hm && hm[4] === sess, "it tests the handler's own session param", hm && hm[4] + " / " + sess);
    ok(part.includes('restart the app."}]}}\n' + stmt), "it sits right after our HIPAA check, at the top of the Linux block");
    ok(new RegExp("if\\(" + ns + "\\." + key + "\\(" + sess + "\\)\\)return [\\w$.]+\\.info\\(`\\[cu\\] \\$\\{[\\w$]+\\} \\\\u2192 deny \\(CLI on an SSH host\\)`\\),[\\w$]+\\(" + textName + "\\);").test(part),
      "upstream's own preamble denies with the same predicate, session and text");
    const file = (new RegExp("(?<![\\w$.])" + ns.replace(/\$/g, "\\$") + "=require\\([\"`]\\./([^\"`]+)[\"`]\\)").exec(part) || [])[1];
    const target = file ? parts[names.indexOf(file)] || "" : "";
    const local = (new RegExp('Object\\.defineProperty\\(exports,"' + key + '",\\{enumerable:!0,get:function\\(\\)\\{return ([\\w$]+)\\}\\}\\)').exec(target) || [])[1];
    const pm = local && new RegExp("function " + local.replace(/\$/g, "\\$") + "\\(([\\w$]+)\\)\\{return \\1\\.cliOnSshHost===!0&&([\\w$]+)\\(\\)\\}").exec(target);
    ok(!!pm, `${ns}.${key} is \`return e.cliOnSshHost===!0&&flag()\``, file + ":" + local);
    const tm = new RegExp("(?<![\\w$.])" + textName.replace(/\$/g, "\\$") + '="([^"]*)"').exec(part);
    ok(!!tm && /runs on another computer over SSH/.test(tm[1]), "the refusal text is upstream's constant", tm && tm[1].slice(0, 60));
    if (!pm || !tm) return;
    let flag = true;
    const sv = new Function(pm[2], "return " + pm[0])(() => flag);
    // The rig names the session param `__session` (as __SESSION__ becomes it).
    const sshRig = { stmt: stmt.replace(`${ns}.${key}(${sess})`, `${ns}.${key}(__session)`), scope: { [ns]: { [key]: sv }, [textName]: tm[1] } };
    const isSshDenial = (r) => r && r.isError === true && r.content.length === 1 && r.content[0].text === tm[1];

    let rig = makeRig({ hipaa: () => false, ssh: sshRig });
    try {
      flag = true;
      const r1 = await rig.handler("cursor_position", {}, { sessionId: "s", cliOnSshHost: true });
      ok(isSshDenial(r1) && rig.calls.length === 0, "cliOnSshHost:true, flag on: refused with upstream's text, executor never reached", JSON.stringify(r1).slice(0, 80));
      ok(rig.diag.some((l) => l.includes("[claude-cu] tool call denied") && l.includes("SSH")), "and one diag line");
      const r2 = await rig.handler("request_access", { apps: ["Files"] }, { cliOnSshHost: true });
      ok(isSshDenial(r2), "request_access (no-executor path) refused too");
      flag = false;
      rig.calls.length = 0;
      const r3 = await rig.handler("cursor_position", {}, { cliOnSshHost: true });
      ok(!r3.isError && rig.calls.includes("getCursorPosition"), "cliOnSshHost:true, flag off: the call passes", JSON.stringify(r3).slice(0, 60));
      flag = true;
      rig.calls.length = 0;
      const r4 = await rig.handler("cursor_position", {}, { cliOnSshHost: false });
      ok(!r4.isError && rig.calls.includes("getCursorPosition"), "cliOnSshHost:false, flag on: the call passes");
    } finally { rig.restore(); }
    rig = makeRig({ hipaa: () => true, ssh: sshRig });
    try {
      const r5 = await rig.handler("cursor_position", {}, { cliOnSshHost: true });
      ok(isDenial(r5), "restricted org and SSH host: the HIPAA refusal first, as upstream's order");
    } finally { rig.restore(); }
    rig = makeRig({ hipaa: () => false, ssh: sshRig, kwin: true });
    try {
      const r6 = await rig.handler("cursor_position", {}, { cliOnSshHost: true });
      ok(r6 === FELL_THROUGH, "kwin mode: falls through, upstream's own preamble denies");
    } finally { rig.restore(); }
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
    await testSshHostDeny();
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
