#!/usr/bin/env node
// Host tools upstream execs by absolute /usr/bin path must fall back to PATH.
//
// WHY THIS EXISTS
// ---------------
// Upstream hardcodes four host tools:
//
//   /usr/bin/busctl         GlobalShortcuts portal probe. If it cannot run, the
//                           app decides there is no portal and refuses every
//                           Wayland global shortcut (Quick Entry included).
//   /usr/bin/secret-tool    Chrome cookie import (libsecret)
//   /usr/bin/kwallet-query  Chrome cookie import (KWallet)
//   /usr/bin/sqlite3        Recent Projects (enabled on Linux by our own
//                           fix_detected_projects_linux)
//
// None of them exist at /usr/bin on NixOS. patches/linux/fix_host_tool_paths_linux
// (first three) and patches/linux/fix_detected_projects_linux (sqlite3) rewrite
// each literal to
//
//   (require("fs").existsSync("/usr/bin/X")?"/usr/bin/X":"X")
//
// This harness runs both compiled patches over upstream's own call-site shapes
// (copied from 2.7032.0), then evaluates the patched code with a fake `fs`:
// file present -> upstream's literal path is kept (Debian/Fedora/Arch behavior
// unchanged); file absent -> the bare name, which execFile resolves via PATH
// (proven against a scratch PATH dir). It also pins idempotency and the
// fail-loud paths (half-patched input, missing site).
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  accessSync,
  chmodSync,
  constants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOST_BIN = join(ROOT, "patches", "linux", "fix_host_tool_paths_linux");
const DP_BIN = join(ROOT, "patches", "linux", "fix_detected_projects_linux");
const SKIP_EXIT = 3;

const TOOLS = [
  { path: "/usr/bin/busctl", name: "busctl", bin: HOST_BIN },
  { path: "/usr/bin/secret-tool", name: "secret-tool", bin: HOST_BIN },
  { path: "/usr/bin/kwallet-query", name: "kwallet-query", bin: HOST_BIN },
  { path: "/usr/bin/sqlite3", name: "sqlite3", bin: DP_BIN },
];

// ---------------------------------------------------------------- reporting
let pass = 0;
const failures = [];

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${JSON.stringify(actual)}`);
    pass++;
    return;
  }
  console.log(
    `  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
  );
  failures.push(label);
}

function section(title) {
  console.log("\n" + title);
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function fallbackExpr(path, name) {
  return `(require("fs").existsSync("${path}")?"${path}":"${name}")`;
}

// ---------------------------------------------------------------- fixture
// Upstream's call sites, verbatim shapes from 2.7032.0 (index.chunk-CxyX_nIQ.js,
// index.chunk-B8YyF2lT.js, index.chunk-D_rPGfDo.js). The patches capture
// identifiers by wildcard; what matters is the shape around each literal.
// `__fixture*` wrappers only expose the values to the harness.
const FIXTURE = `"use strict";
var kk=()=>globalThis.process?.env??{};async function N9t(e){let{stdout:t}=await wf("/usr/bin/busctl",["--user","--timeout=2",...e],{timeout:3e3,hardTimeoutMs:5e3});return t}
var M="/usr/bin/secret-tool",ae="/usr/bin/kwallet-query",N={chrome:{app:"chrome",name:"Chrome"},chromium:{app:"chromium",name:"Chromium"}};
async function O(){if(process.platform!=="darwin")return t.pK.debug(\`[detectedProjects] skipping on \${process.platform} (macOS only)\`),[];return["ran"]}
async function y(e,a,o){t.pK.debug(\`[detectedProjects]   reading \${o}\`);let{stdout:s}=await t.rU("/usr/bin/sqlite3",["-readonly",e,a],{timeout:5e3});return s}
async function v(e,i){t.pK.debug(\`[detectedProjects] scanning \${i} (\${e})...\`);let o=await _(n.default.join((0,r.homedir)(),"Library","Application Support",e,"User","globalStorage","state.vscdb"),"SELECT");return o}
async function z(){t.pK.debug("[detectedProjects] scanning zed...");let e=await _(n.default.join((0,r.homedir)(),"Library","Application Support","Zed","db","0-stable","db.sqlite"),\`SELECT paths FROM workspaces\`);return e}
globalThis.__fixture={N9t,O,y,v,z,cookieTools:()=>[M,ae]};
`;

// ---------------------------------------------------------------- patch runs
function runBin(bin, file) {
  try {
    const out = execFileSync(bin, [file], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, out };
  } catch (e) {
    return {
      status: typeof e.status === "number" ? e.status : -1,
      out: String(e.stdout || "") + String(e.stderr || ""),
    };
  }
}

// Evaluate the patched fixture with `present` as the set of files that exist.
// Returns the program each call site would exec, plus the paths existsSync saw.
async function evaluate(src, present) {
  const probed = [];
  const execd = [];
  const sandbox = {
    process: { platform: "linux", env: {} },
    require: (m) => {
      if (m !== "fs") throw new Error("unexpected require: " + m);
      return {
        existsSync: (p) => {
          probed.push(p);
          return present.has(p);
        },
      };
    },
    wf: async (bin) => {
      execd.push(bin);
      return { stdout: "" };
    },
    t: {
      pK: { debug() {} },
      rU: async (bin) => {
        execd.push(bin);
        return { stdout: "" };
      },
    },
    _: async (p) => p,
    n: { default: { join: (...s) => s.join("/") } },
    r: { homedir: () => "/home/u" },
  };
  vm.runInNewContext(src, vm.createContext(sandbox));
  const f = sandbox.__fixture;
  const [secretTool, kwalletQuery] = f.cookieTools();
  await f.N9t(["status"]);
  await f.y("db", "SELECT 1", "vscode");
  return {
    busctl: execd[0],
    "secret-tool": secretTool,
    "kwallet-query": kwalletQuery,
    sqlite3: execd[1],
    guard: await f.O(),
    vscode: await f.v("Code", "VS Code"),
    zed: await f.z(),
    probed,
  };
}

for (const bin of [HOST_BIN, DP_BIN]) {
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    console.error(
      `SKIP: ${bin.slice(ROOT.length + 1)} is not compiled ` +
        "(run: cd patches && make -j\"$(nproc)\")"
    );
    process.exit(SKIP_EXIT);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "cdb-host-tool-paths-"));

try {
  // ---------------------------------------------------------------- [0] apply
  section("[0] both patches apply to upstream's shapes, in orchestrator order");
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  // Basename order: fix_detected_projects_linux < fix_host_tool_paths_linux.
  const dp = runBin(DP_BIN, file);
  check("fix_detected_projects_linux exits 0", dp.status, 0);
  check("fix_detected_projects_linux reports no failure", /\[FAIL\]/.test(dp.out), false);
  const host = runBin(HOST_BIN, file);
  check("fix_host_tool_paths_linux exits 0", host.status, 0);
  check("fix_host_tool_paths_linux reports no failure", /\[FAIL\]/.test(host.out), false);
  check(
    "a first run never says 'already' (the probe would read PARTIAL)",
    /already/i.test(dp.out + host.out),
    false
  );
  const patched = readFileSync(file, "utf8");
  execFileSync("node", ["--check", file]);
  check("the patched fixture passes node --check", true, true);

  // ---------------------------------------------------------------- [1] shape
  section("[1] every literal became exactly one fallback expression");
  for (const { path, name } of TOOLS) {
    const expr = fallbackExpr(path, name);
    check(`${name}: fallback expression count`, countOf(patched, expr), 1);
    check(
      `${name}: no bare literal left outside it`,
      countOf(patched.split(expr).join(""), `"${path}"`),
      0
    );
  }

  // ---------------------------------------------------------------- [2] eval
  section("[2] file present keeps upstream's path; absent falls back to the bare name");
  const allPresent = new Set(TOOLS.map((t) => t.path));
  const withAll = await evaluate(patched, allPresent);
  const withNone = await evaluate(patched, new Set());
  for (const { path, name } of TOOLS) {
    check(`${name}: present -> literal`, withAll[name], path);
    check(`${name}: absent -> PATH name`, withNone[name], name);
    check(`${name}: existsSync probes the exact literal`, withNone.probed.includes(path), true);
  }
  // Mixed host: one tool at /usr/bin, the rest elsewhere on PATH.
  const mixed = await evaluate(patched, new Set(["/usr/bin/busctl"]));
  check("mixed: busctl keeps /usr/bin", mixed.busctl, "/usr/bin/busctl");
  check("mixed: secret-tool falls back", mixed["secret-tool"], "secret-tool");

  // fix_detected_projects_linux's other sub-patches still do their job.
  check("detected projects: Linux passes the platform guard", withNone.guard[0], "ran");
  check(
    "detected projects: VS Code DB under ~/.config",
    withNone.vscode,
    "/home/u/.config/Code/User/globalStorage/state.vscdb"
  );
  check(
    "detected projects: Zed DB under ~/.local/share",
    withNone.zed,
    "/home/u/.local/share/zed/db/0-stable/db.sqlite"
  );

  // ---------------------------------------------------------------- [3] PATH
  section("[3] the bare name really resolves through PATH (execFile lookup)");
  const fakeBin = join(scratch, "bin");
  execFileSync("mkdir", ["-p", fakeBin]);
  const fakeBusctl = join(fakeBin, "busctl");
  writeFileSync(fakeBusctl, "#!/bin/sh\necho fake-busctl\n");
  chmodSync(fakeBusctl, 0o755);
  const out = execFileSync(withNone.busctl, ["--user"], {
    encoding: "utf8",
    env: { PATH: fakeBin },
  }).trim();
  check("execFile(\"busctl\") runs the copy on PATH", out, "fake-busctl");

  // ---------------------------------------------------------------- [4] idempotent
  section("[4] a second run is a no-op with a positive 'already'");
  for (const bin of [DP_BIN, HOST_BIN]) {
    const again = join(scratch, "again.js");
    writeFileSync(again, patched);
    const r = runBin(bin, again);
    const short = bin.split("/").pop();
    check(`${short}: second run exits 0`, r.status, 0);
    check(`${short}: second run changes nothing`, readFileSync(again, "utf8") === patched, true);
    check(`${short}: second run says 'already'`, /\[OK\].*already/.test(r.out), true);
  }

  // ---------------------------------------------------------------- [5] fail loud
  section("[5] half-patched or missing sites fail the build");
  for (const { path, name, bin } of TOOLS) {
    const short = bin.split("/").pop();
    // Both the fallback AND an old literal present (e.g. upstream added a site).
    const both = join(scratch, `both-${name}.js`);
    writeFileSync(both, patched + `\nvar __extra="${path}";\n`);
    check(`${short}: fallback + extra ${name} literal -> exit 1`, runBin(bin, both).status, 1);
    // Site missing from a pristine bundle (upstream moved it).
    const gone = join(scratch, `gone-${name}.js`);
    writeFileSync(gone, FIXTURE.split(`"${path}"`).join(`"/opt/moved/${name}"`));
    check(`${short}: ${name} site missing -> exit 1`, runBin(bin, gone).status, 1);
    // Two pristine sites (count must be exactly 1).
    const two = join(scratch, `two-${name}.js`);
    writeFileSync(two, FIXTURE + `\nvar __dup="${path}";\n`);
    check(`${short}: two ${name} literals -> exit 1`, runBin(bin, two).status, 1);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
