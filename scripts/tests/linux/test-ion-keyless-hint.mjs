#!/usr/bin/env node
// Cowork device popover: a hint when THIS Linux desktop connected keyless.
//
// WHY THIS EXISTS
// ---------------
// A Linux user who cannot open /dev/tpmrm0 registers this desktop with
// Anthropic's servers as a KEYLESS device. It still connects, so the Cowork
// header device popover (ion-dist SPA) shows a green dot and "Connected -
// Claude can use the files and apps on your computer.", but the server never
// attaches computer tools to a keyless device's sessions: cloud Cowork /
// Dispatch has no Computer Use and nothing says why. Sub-patch C of
// patches/linux/fix_ion_dist_linux.nim wraps the popover's status-line builder
// call (4.4212.0 names):
//   {title:d,statusLine:f,iconLabel:p}=Mj(n)
//   -> {title:d,statusLine:f,iconLabel:p}=__cdbKeylessHint(Mj(n),n)
// and inserts the helper before Mj. The helper reads window.process.platform
// (upstream's preload) and upstream's deviceLinkStore
// (globalThis["claude.web"].WindowState) and only on Linux + linkedHere +
// "connected" + a keyless local link swaps the dot to the warning color and the
// detail to a pointer at Settings -> Extra -> Community -> Computer Use status.
//
// This harness pins:
//   [A] the compiled patch on a fixture built from the verbatim 4.4212.0
//       shapes: applies with the full counter, idempotent (byte-identical
//       second run), node --check, and Rule 6 refusals (half-patched call or
//       helper, builder props renamed, the signature in two files)
//   [B] the helper over the real upstream status function (Aj/jj from the
//       fixture, which are verbatim): keyless + Linux + linkedHere + connected
//       -> hint; keyed, other platforms, not linked here, not connected, store
//       missing / throwing / down -> upstream's object unchanged (===); live
//       store updates; stable identity per input object
//   [C] the same against the real SPA (resources/ion-dist.asar under
//       tmp/extract, SKIPPED when there is none; CDB_ION_TREE points at another
//       install tree): pristine anchors, one apply over every assets/v1 file,
//       exactly three files changed, the C file differs only by our two
//       splices, node --check, idempotent, and [B]'s table over the REAL
//       patched Aj/jj and helper.
//
// CDB_ION_PATCH_BIN points at another compiled binary.
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, accessSync, constants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { openIonDist } from "../lib/ion-dist.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_SRC = path.join(repo, "patches", "linux", "fix_ion_dist_linux.nim");
const PATCH_BIN = process.env.CDB_ION_PATCH_BIN || path.join(repo, "patches", "linux", "fix_ion_dist_linux");
const ION_TREE = process.env.CDB_ION_TREE || path.join(repo, "tmp", "extract", "usr", "lib", "claude-desktop");
const EXPECTED_PATCHES = Number(/const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(PATCH_SRC, "utf8"))[1]);
const HINT =
  "Connected without a device key, so Computer Use is not available in Cowork. Open Settings -> Extra -> Community -> Computer Use status to fix it.";
const MARKER = "/*cdb:keyless-hint*/";

let pass = 0;
let skipped = false;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${actual}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`);
    failures.push(label);
  }
}
const count = (hay, needle) => hay.split(needle).length - 1;
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;

const CALL_RE = /\{title:([\w$]+),statusLine:([\w$]+),iconLabel:([\w$]+)\}=([\w$]+)\(([\w$]+)\)/;
const PATCHED_CALL_RE =
  /\{title:[\w$]+,statusLine:[\w$]+,iconLabel:[\w$]+\}=__cdbKeylessHint\(([\w$]+)\(([\w$]+)\),\2\)/;
const BUILDER_RE =
  /function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\(\d+\),\{linkedHere:[\w$]+,usableFromHere:[\w$]+,computerName:[\w$]+,status:[\w$]+,/;

// Source of `function NAME(` ... matching `}`, skipping string literals.
function functionSource(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  let depth = 0;
  let q = null;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

function runPatch(dir) {
  const r = spawnSync(PATCH_BIN, [dir], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function snapshot(dir) {
  const v1 = path.join(dir, "assets", "v1");
  return Object.fromEntries(readdirSync(v1).map((f) => [f, readFileSync(path.join(v1, f), "utf8")]));
}
function nodeCheck(text) {
  const d = mkdtempSync(path.join(tmpdir(), "cdb-kh-chk-"));
  const f = path.join(d, "c.mjs");
  writeFileSync(f, text);
  const r = spawnSync("node", ["--check", f], { encoding: "utf8" });
  rmSync(d, { recursive: true, force: true });
  return r.status === 0;
}

// A sandbox over the patched chunk's pieces: the real status builder (Aj) and
// its message helper (jj), plus our helper block. `store` shapes
// globalThis["claude.web"].WindowState.deviceLinkStore.
function makeEnv(patchedSrc, { platform, store }) {
  const call = PATCHED_CALL_RE.exec(patchedSrc);
  const mj = call[1];
  const mjSrc = functionSource(patchedSrc, mj);
  const aj = /[\w$]+=([\w$]+)\([\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+\),/.exec(mjSrc)[1];
  const ajSrc = functionSource(patchedSrc, aj);
  const jj = /detail:[\w$]+==="connected"\?([\w$]+)\(/.exec(ajSrc)[1];
  const jjSrc = functionSource(patchedSrc, jj);
  const hStart = patchedSrc.indexOf(MARKER);
  const hEnd = patchedSrc.indexOf("function " + mj + "(", hStart);
  const helperSrc = patchedSrc.slice(hStart, hEnd);
  const sb = {};
  if (platform !== undefined) sb.process = { platform };
  let listener = null;
  const calls = { sync: 0 };
  if (store !== undefined) {
    sb["claude.web"] = {
      WindowState: {
        deviceLinkStore: {
          getStateSync() {
            calls.sync++;
            if (store === "throw") throw new Error("No reply from the main process");
            return store;
          },
          onStateChange(cb) {
            listener = cb;
            return () => {};
          },
        },
      },
    };
  }
  const ctx = vm.createContext(sb);
  vm.runInContext(`${ajSrc};${jjSrc};${helperSrc};globalThis.__aj=${aj};`, ctx);
  const intl = { formatMessage: (d) => d.defaultMessage };
  // What Mj returns for the header (title / iconLabel are Mj's own; the
  // statusLine is Aj's, called the way Mj calls it: no statusLabel/statusText).
  const built = (status, usable = true) => ({
    title: "this-laptop",
    statusLine: ctx.__aj(intl, status, undefined, undefined, undefined, undefined, false, usable),
    iconLabel: "this-laptop, Connected",
  });
  return {
    built,
    hint: (r, props) => ctx.__cdbKeylessHint(r, props),
    emit: (s) => listener && listener(s),
    calls,
    helperSrc,
  };
}

const KEYLESS = { connected: true, idSource: "keyless", presentedDeviceId: "abc" };
const KEYED = { connected: true, idSource: "keyed", presentedDeviceId: "abc" };
const HERE = { linkedHere: true, status: "connected" };

function behaviorTable(tag, src) {
  {
    const e = makeEnv(src, { platform: "linux", store: KEYLESS });
    const r = e.built("connected");
    check(`${tag} upstream connected detail`, r.statusLine.detail, "Claude can use the files and apps on your computer.");
    check(`${tag} upstream connected dot`, r.statusLine.dotColor, "var(--cds-fill-success)");
    const h = e.hint(r, HERE);
    check(`${tag} keyless linux: new object`, h !== r, true);
    check(`${tag} keyless linux: dot`, h.statusLine.dotColor, "var(--cds-fill-warning)");
    check(`${tag} keyless linux: detail`, h.statusLine.detail, HINT);
    check(`${tag} keyless linux: text kept`, h.statusLine.text, "Connected");
    check(`${tag} keyless linux: label kept`, h.statusLine.label, "Connected");
    check(`${tag} keyless linux: title/iconLabel kept`, `${h.title}|${h.iconLabel}`, `${r.title}|${r.iconLabel}`);
    check(`${tag} keyless linux: input untouched`, r.statusLine.dotColor, "var(--cds-fill-success)");
    check(`${tag} keyless linux: stable identity`, e.hint(r, HERE) === h, true);
    check(`${tag} one sync read, then subscription`, e.calls.sync, 1);
    check(`${tag} no em-dash in hint`, /\u2014/.test(h.statusLine.detail), false);
    e.emit(KEYED);
    check(`${tag} store flips to keyed -> upstream`, e.hint(r, HERE) === r, true);
    check(`${tag} still one sync read`, e.calls.sync, 1);
  }
  {
    const e = makeEnv(src, { platform: "linux", store: KEYED });
    const r = e.built("connected");
    check(`${tag} keyed linux -> upstream (===)`, e.hint(r, HERE) === r, true);
    e.emit(KEYLESS);
    check(`${tag} store flips to keyless -> hint`, e.hint(r, HERE).statusLine.detail, HINT);
  }
  for (const platform of ["darwin", "win32", undefined]) {
    const e = makeEnv(src, { platform, store: KEYLESS });
    const r = e.built("connected");
    check(`${tag} keyless ${platform ?? "no window.process"} -> upstream (===)`, e.hint(r, HERE) === r, true);
  }
  {
    const e = makeEnv(src, { platform: "linux", store: KEYLESS });
    const r = e.built("connected");
    check(`${tag} linkedHere false -> upstream`, e.hint(r, { linkedHere: false, status: "connected" }) === r, true);
    check(`${tag} linkedHere missing -> upstream`, e.hint(r, { status: "connected" }) === r, true);
    check(`${tag} props missing -> upstream`, e.hint(r, undefined) === r, true);
    const asleep = e.built("disconnected");
    check(`${tag} asleep -> upstream`, e.hint(asleep, { linkedHere: true, status: "disconnected" }) === asleep, true);
    check(`${tag} status unknown (undefined line) -> upstream`, e.hint(e.built("unknown"), { linkedHere: true, status: "unknown" }).statusLine, undefined);
    check(`${tag} undefined result passes through`, e.hint(undefined, HERE), undefined);
  }
  for (const [label, store] of [
    ["no claude.web bridge", undefined],
    ["getStateSync throws", "throw"],
    ["local link down", { connected: false, downCause: "closed" }],
    ["idSource none", { connected: true, idSource: "none" }],
  ]) {
    const e = makeEnv(src, { platform: "linux", store });
    const r = e.built("connected");
    check(`${tag} ${label} -> upstream (===)`, e.hint(r, HERE) === r, true);
  }
}

// ---------------------------------------------------------------- fixture
// The verbatim 4.4212.0 status builder (Aj) + message helper (jj), the
// builder's props destructure and the call site; the rest of Mj/Nj reduced.
const FIX_C = [
  'function Aj(e,t,n,r,i,a,o,s){if(t===void 0||t==="unknown")return i===void 0?void 0:{text:i};if(t!=="connected"&&o){let t=e.formatMessage({defaultMessage:"Sign in again to access local files on your computer.",id:"52YJtcI6Bv"});return{dotColor:"var(--cds-fill-warning)",text:t,label:t}}if(t!=="connected"&&n){let t=r(e,n);return{dotColor:"var(--cds-fill-warning)",text:t,label:t}}let c=t==="connected"?e.formatMessage({defaultMessage:"Connected",id:"IvjoDSPGEQ"}):e.formatMessage({defaultMessage:"Asleep or app closed",id:"5I/DeyD+rW"});return{dotColor:t==="connected"?"var(--cds-fill-success)":"var(--cds-fill-warning)",text:i??a??c,detail:t==="connected"?jj(e,s):i===void 0?void 0:a,label:c}}',
  'function jj(e,t){return t?e.formatMessage({defaultMessage:"Claude can use the files and apps on your computer.",id:"cQTH9F2BGU"}):e.formatMessage({defaultMessage:"Claude can use its files and apps only from the Claude desktop app on that computer.",id:"myH5Qe0xBl"})}',
  "function Mj(e){let $=J9(22),{linkedHere:t,usableFromHere:n,computerName:r,status:i,connectedElsewhere:a,formatConnectedElsewhere:o,statusLabel:s,statusText:c,onSignIn:l,linkOffer:u}=e,d=n===void 0||n,p=Rs(),m=l!==void 0,g;return g=Aj(p,i,a,o,s,c,m,d),{title:r,statusLine:g,iconLabel:r}}",
  "function Nj(e){let $=J9(49),n=e,c=n.muted??!1,l=Rs(),u=Ge(),{title:d,statusLine:f,iconLabel:p}=Mj(n),m=f?.dotColor;return[d,f,p,m,c,l,u]}",
  "export{Nj as t};",
].join("");
const FIX_A = 'var e={id:"plugins",mountPath:{mac:"/Library/Application Support/Claude/org-plugins",win:"%ProgramFiles%\\\\Claude\\\\org-plugins"}};export{e as t};';
const FIX_B = "function f(r,W,t){return r===W.Win32?t.win:t.mac}export{f as t};";

function writeFixture(files) {
  const d = mkdtempSync(path.join(tmpdir(), "cdb-kh-fx-"));
  mkdirSync(path.join(d, "assets", "v1"), { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(path.join(d, "assets", "v1", n), t);
  return d;
}

let runnable = false;
try {
  accessSync(PATCH_BIN, constants.X_OK);
  runnable = true;
} catch {}

console.log("[A] compiled patch on the verbatim 4.4212.0 shapes");
let patchedFixture = null;
if (!runnable) {
  console.log("  SKIP patch binary not compiled (cd patches && make)");
  skipped = true;
} else {
  check("fixture C parses", nodeCheck(FIX_C), true);
  const d = writeFixture({ "ca.js": FIX_A, "cb.js": FIX_B, "cc.js": FIX_C });
  const r1 = runPatch(d);
  check("applies (exit 0)", r1.status, 0);
  check("full counter", r1.out.includes(`[PASS] All ${EXPECTED_PATCHES} patches applied`), true);
  check("reports sub-patch C", /\[OK\] keyless device hint: 1 match \(cc\.js\)/.test(r1.out), true);
  const s1 = snapshot(d);
  const c = s1["cc.js"];
  patchedFixture = c;
  check("call wrapped once", countRe(c, PATCHED_CALL_RE), 1);
  check("upstream call gone", countRe(c, CALL_RE), 0);
  check("helper once", count(c, MARKER), 1);
  const helperSrc = c.slice(c.indexOf(MARKER), c.indexOf("function Mj("));
  check("helper directly precedes Mj", c.includes(helperSrc + "function Mj(e){") && helperSrc.length > 0, true);
  check(
    "only our two splices differ",
    c.replace(helperSrc, "").replace("=__cdbKeylessHint(Mj(n),n)", "=Mj(n)") === FIX_C,
    true
  );
  check("patched C passes node --check", nodeCheck(c), true);
  const r2 = runPatch(d);
  check("second run exit 0", r2.status, 0);
  check("second run says already applied", /\[OK\] keyless device hint: already applied/.test(r2.out), true);
  check("second run byte-identical", JSON.stringify(snapshot(d)) === JSON.stringify(s1), true);
  rmSync(d, { recursive: true, force: true });

  const refusals = [
    ["call wrapped, helper missing", { "cc.js": c.replace(helperSrc, "") }],
    ["helper present, call unwrapped", { "cc.js": c.replace("=__cdbKeylessHint(Mj(n),n)", "=Mj(n)") }],
    ["helper text altered", { "cc.js": c.replace('idSource!=="keyless"', 'idSource!=="keyed"') }],
    ["builder props renamed (pristine)", { "cc.js": FIX_C.replace("{linkedHere:t,", "{boundHere:t,") }],
    ["call site moved (pristine)", { "cc.js": FIX_C.replace("{title:d,statusLine:f,iconLabel:p}=Mj(n)", "q=Mj(n)") }],
    ["signature in two files", { "cc.js": FIX_C, "cd.js": FIX_C }],
    ["signature missing", { "cc.js": FIX_C.replace("cQTH9F2BGU", "XXXXXXXXXX") }],
  ];
  for (const [label, files] of refusals) {
    const fd = writeFixture({ "ca.js": FIX_A, "cb.js": FIX_B, ...files });
    const r = runPatch(fd);
    check(`refused: ${label}`, r.status !== 0 && /\[FAIL\] keyless device hint/.test(r.out), true);
    rmSync(fd, { recursive: true, force: true });
  }
}

console.log("\n[B] helper over the verbatim status builder (fixture)");
if (patchedFixture) behaviorTable("fx", patchedFixture);
else console.log("  SKIP needs [A]");

console.log("\n[C] the real SPA");
const ion = openIonDist(ION_TREE);
if (!runnable || !ion) {
  console.log(`  SKIP ${!runnable ? "patch binary not compiled" : "no ion-dist under " + ION_TREE}`);
  skipped = true;
} else {
  const d = mkdtempSync(path.join(tmpdir(), "cdb-kh-ion-"));
  const v1 = path.join(d, "assets", "v1");
  mkdirSync(v1, { recursive: true });
  const jsFiles = ion.list("assets/v1").filter((f) => f.endsWith(".js"));
  for (const f of jsFiles) writeFileSync(path.join(v1, f), ion.read("assets/v1/" + f));
  const before = snapshot(d);
  const sigFiles = jsFiles.filter((f) => before[f].includes("cQTH9F2BGU"));
  check("pristine: signature in exactly one file", sigFiles.length, 1);
  const pf = before[sigFiles[0]] || "";
  check("pristine: call site once", countRe(pf, CALL_RE), 1);
  check("pristine: builder once", countRe(pf, BUILDER_RE), 1);
  check("pristine: call's callee is the builder", CALL_RE.exec(pf)?.[4], BUILDER_RE.exec(pf)?.[1]);
  check("pristine: nothing of ours", jsFiles.filter((f) => before[f].includes("__cdbKeylessHint")).length, 0);
  const r1 = runPatch(d);
  check("real: applies (exit 0)", r1.status, 0);
  check("real: full counter", r1.out.includes(`[PASS] All ${EXPECTED_PATCHES} patches applied`), true);
  const after = snapshot(d);
  const changed = jsFiles.filter((f) => after[f] !== before[f]);
  check("real: exactly three files changed (A, B, C)", changed.length, 3);
  const c = after[sigFiles[0]];
  const callee = PATCHED_CALL_RE.exec(c)?.[1];
  const arg = PATCHED_CALL_RE.exec(c)?.[2];
  const helperSrc = c.slice(c.indexOf(MARKER), c.indexOf("function " + callee + "(", c.indexOf(MARKER)));
  check(
    "real: C differs only by our two splices",
    c.replace(helperSrc, "").replace(`=__cdbKeylessHint(${callee}(${arg}),${arg})`, `=${callee}(${arg})`) === pf,
    true
  );
  check("real: helper inserted immediately before the builder", c.indexOf(helperSrc + "function " + callee + "(") >= 0, true);
  check("real: patched C passes node --check", nodeCheck(c), true);
  const r2 = runPatch(d);
  check("real: second run exit 0", r2.status, 0);
  check("real: second run byte-identical", JSON.stringify(snapshot(d)) === JSON.stringify(after), true);
  behaviorTable("real", c);
  rmSync(d, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) {
  console.log(`${pass} checks passed; some sections SKIPPED`);
  process.exit(SKIP_EXIT);
}
console.log("ALL " + pass + " CHECKS PASSED");
