#!/usr/bin/env node
// Marketplace plugin scope: fix_marketplace_linux promotes $HOME
// project-scoped Claude Code CLI plugins to user scope ("Personal Plugins").
//
// WHAT IT CHECKS
// --------------
// The Claude Code CLI stores personal plugins as scope="project" with
// projectPath=$HOME. patches/linux/fix_marketplace_linux.nim rewrites the
// user-scope branch of getAllLocalPluginsWithResolver
//
//   if(c.scope==="user")return this.entryToPluginInfo(r,c,o,l);
//
// so such an entry is returned as {...c,scope:"user"}. Upstream's CCD routing
// (the D5 gate) and the unrelated realpath helpers that start with
// `{return process.platform==="linux"||` must stay byte-identical.
//
// This harness runs the compiled patch on the 3.1623.0 shapes and evaluates
// the rewritten resolver branch.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  accessSync,
  constants,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_marketplace_linux");
const SKIP_EXIT = 3;

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
const section = (t) => console.log("\n" + t);

// Upstream shapes from 3.1623.0, trimmed. Verbatim:
//   - the two realpath helpers Rs / hs (chunks DyxrY3CK and Ghv0q1hg)
//   - the CCD gate D5 and its caller UMa (chunk 6Ku8p4x3)
//   - the resolver branch of getAllLocalPluginsWithResolver (chunk 6Ku8p4x3),
//     from `let c=` to `return null`, minus the async JT() manifest read
// entryToPluginInfo is trimmed to the fields the UI groups by.
const RS = 'function Rs(e){return process.platform==="linux"||e==="/"?e:(0,i.realpathSync)(e)}';
const HS = 'function hs(e){return process.platform==="linux"||e==="/"?e:(0,r.realpathSync)(e)}';
const GATE = 'function D5(e){return e?.mode==="ccd"}';
const GATE_CALLER = 'function UMa(e){return D5(e)&&e?.pluginSource==="local"}';
const ANCHOR = 'if(c.scope==="user")return this.entryToPluginInfo(r,c,o,l);';
const PATCHED_ANCHOR =
  'if(c.scope==="user"||c.scope==="project"&&c.projectPath&&process.env.HOME&&' +
  'require("path").normalize(c.projectPath)===require("path").normalize(process.env.HOME))' +
  'return this.entryToPluginInfo(r,{...c,scope:"user"},o,l);';
const RESOLVER =
  `resolve(r,i,o,l,t,a){let c={...i,installPath:a};${ANCHOR}` +
  'if(c.scope==="project"||c.scope==="local"){if(!t||!c.projectPath)return null;' +
  "let e=(0,n.normalize)(t),i=(0,n.normalize)(c.projectPath);" +
  "if(e===i||e.startsWith(i+n.sep))return this.entryToPluginInfo(r,c,o,l)}return null}";
const FIXTURE = `"use strict";
var i={realpathSync:e=>"real:"+e},r=i,n=require("path");
${RS}
${HS}
${GATE}${GATE_CALLER}
class Pm{entryToPluginInfo(e,t,n,r){return{id:e,name:e.split("@")[0]||e,installPath:t.installPath,scope:t.scope,enabled:n[e]===!0}}${RESOLVER}}
`;

// B's "already patched" check (copied from the .nim). The pristine fixture
// must not trip it, or the patch would report success without patching.
const B_IDEMPOTENCY_RE =
  /(?:if\(|return )[\w$.]+==="user"\|\|[\w$]+\.scope==="project"&&[\w$]+\.projectPath/;

// Every patch run is kept (exit code, combined stdout+stderr) and dumped when a
// check fails: a binary that dies before printing anything (e.g. a std/nre
// build whose PCRE1 dlopen fails on the runner) would otherwise show up only
// as "first run exits 1" with no output.
const patchRuns = [];
function runPatch(file) {
  const r = spawnSync(PATCH_BIN, [file], { encoding: "utf8" });
  const run = {
    file,
    status: r.status === null ? -1 : r.status,
    signal: r.signal || null,
    error: r.error ? String(r.error.message || r.error) : null,
    out: String(r.stdout || "") + String(r.stderr || ""),
  };
  patchRuns.push(run);
  return run;
}
function dumpPatchRuns() {
  console.log(`\n--- ${PATCH_BIN}: ${patchRuns.length} run(s), stdout+stderr ---`);
  for (const r of patchRuns) {
    const tail = r.signal ? ` signal=${r.signal}` : r.error ? ` error=${r.error}` : "";
    console.log(`[exit ${r.status}${tail}] ${r.file}`);
    console.log(r.out.trim() === "" ? "  (no output)" : r.out.replace(/\s+$/, ""));
  }
}

// Instantiate the fixture's Pm resolver with the given $HOME.
function resolver(src, home) {
  const env = home === undefined ? {} : { HOME: home };
  const sandbox = {
    process: { platform: "linux", env },
    require: createRequire(import.meta.url),
    __pm: null,
  };
  vm.runInNewContext(src + "\n;__pm=new Pm;", vm.createContext(sandbox));
  const pm = sandbox.__pm;
  return (entry, cwd) => {
    const info = pm.resolve("foo@market", entry, { "foo@market": true }, {}, cwd, "/plugins/foo");
    return info === null ? null : info.scope;
  };
}

const scratch = mkdtempSync(join(tmpdir(), "cdb-marketplace-scope-"));
try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.error(
    "SKIP: patches/linux/fix_marketplace_linux is not compiled " +
      "(run: make -C patches linux/fix_marketplace_linux)"
  );
  rmSync(scratch, { recursive: true, force: true });
  process.exit(SKIP_EXIT);
}

try {
  section("[A0] pristine 3.1623.0 shapes: scope promotion applies");
  check("pristine fixture does not trip B's 'already patched' check", B_IDEMPOTENCY_RE.test(FIXTURE), false);
  execFileSync("node", ["--check", "-"], { input: FIXTURE });
  check("pristine fixture passes node --check", true, true);
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  const r1 = runPatch(file);
  check("first run exits 0", r1.status, 0);
  check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
  check("B reports an applied match", /\[OK\] B scope normalization \(1 match, return-style\)/.test(r1.out), true);
  check("B does not report 'already patched'", /B already patched/.test(r1.out), false);
  const patched = readFileSync(file, "utf8");
  check("rewritten branch present exactly once", patched.split(PATCHED_ANCHOR).length - 1, 1);
  check("only B's anchor changed", patched.replace(PATCHED_ANCHOR, ANCHOR) === FIXTURE, true);
  execFileSync("node", ["--check", file]);
  check("patched fixture passes node --check", true, true);

  section("[A1] upstream CCD routing and realpath helpers are untouched");
  check("D5 gate byte-identical", patched.split(GATE).length - 1, 1);
  check("D5 caller byte-identical", patched.split(GATE_CALLER).length - 1, 1);
  check("Rs byte-identical", patched.split(RS).length - 1, 1);
  check("hs byte-identical", patched.split(HS).length - 1, 1);
  check(
    "no platform-forced CCD gate injected",
    /process\.platform==="linux"\|\|\([\w$]+==null\?void 0:[\w$]+\.mode\)==="ccd"/.test(patched),
    false
  );

  section("[A2] idempotency: a second run changes nothing and exits 0");
  const r2 = runPatch(file);
  check("second run exits 0", r2.status, 0);
  check("second run reports B already patched", /B already patched/.test(r2.out), true);
  check("second run leaves the file byte-identical", readFileSync(file, "utf8") === patched, true);

  section("[A3] missing anchor fails loud");
  {
    const f = join(scratch, "missing.js");
    writeFileSync(f, FIXTURE.replace(ANCHOR, ""));
    const r = runPatch(f);
    check("anchor missing: exits non-zero", r.status !== 0, true);
    check("anchor missing: prints 0 matches", /\[FAIL\] B scope normalization: 0 matches/.test(r.out), true);
    check("anchor missing: no [PASS] line", /\[PASS\]/.test(r.out), false);
  }

  const HOME = "/home/u";
  const proj = (projectPath) => ({ scope: "project", projectPath });

  section("[B0] unpatched resolver: $HOME project plugins keep project scope");
  {
    const scope = resolver(FIXTURE, HOME);
    check("project@$HOME, cwd below $HOME", scope(proj(HOME), "/home/u/work"), "project");
    check("project@$HOME, no cwd", scope(proj(HOME), undefined), null);
  }

  section("[B1] patched resolver: $HOME project plugins become user scope");
  {
    const scope = resolver(patched, HOME);
    check("user scope", scope({ scope: "user" }, "/home/u/work"), "user");
    check("project@$HOME, cwd below $HOME", scope(proj(HOME), "/home/u/work"), "user");
    check("project@$HOME, no cwd", scope(proj(HOME), undefined), "user");
    check("project@$HOME, cwd elsewhere", scope(proj(HOME), "/srv/x"), "user");
    check("project@$HOME spelled /home/u/./", scope(proj("/home/u/."), undefined), "user");
    check("real project, cwd inside", scope(proj("/home/u/work"), "/home/u/work/sub"), "project");
    check("real project, cwd outside", scope(proj("/home/u/work"), "/srv/x"), null);
    check("local@$HOME stays local", scope({ scope: "local", projectPath: HOME }, "/home/u/work"), "local");
    check("project without projectPath", scope({ scope: "project" }, "/home/u/work"), null);
    const entry = proj(HOME);
    scope(entry, undefined);
    check("input entry not mutated", entry.scope, "project");
  }
  {
    const scope = resolver(patched, undefined);
    check("HOME unset: project@/home/u keeps project scope", scope(proj(HOME), "/home/u/work"), "project");
  }

  // v6.28899.2: the thunk's if/return became one conditional return. Verbatim
  // from getAllLocalPluginsWithResolver (chunk DCZeUEzD), from `f=()=>` to the
  // end of the conditional; `t.ect` (cwd inside projectPath) and the skipped
  // helper `o` are stubbed.
  section("[C0] v6.28899.2 ternary-thunk shape: scope promotion applies");
  {
    const TERNARY =
      'f=()=>this.entryToPluginInfo(r,u,c,d),p=u.scope;return p==="user"?{plugin:f()}:' +
      'p==="project"||p==="local"?typeof u.projectPath!="string"||!u.projectPath?o("never"):' +
      'n&&t.ect(n,u.projectPath)?{plugin:f()}:{otherFolderPlugin:f()}:' +
      'p==="managed"?{...o("never"),managed:{id:r,installPath:u.installPath}}:o("perhaps")';
    const FIX2 = `"use strict";
var t={ect:(e,p)=>{const n=require("path");e=n.normalize(e);p=n.normalize(p);return e===p||e.startsWith(p+n.sep)}};
class Pm{entryToPluginInfo(e,t,n,r){return{id:e,scope:t.scope,enabled:n[e]===!0}}res(r,u,c,d,n){let o=e=>({skipped:e}),${TERNARY}}}
`;
    check("pristine ternary fixture does not trip B's 'already patched' check", B_IDEMPOTENCY_RE.test(FIX2), false);
    const f = join(scratch, "ternary.js");
    writeFileSync(f, FIX2);
    const r1 = runPatch(f);
    check("ternary: first run exits 0", r1.status, 0);
    check("ternary: B reports the ternary-thunk match", /\[OK\] B scope normalization \(1 match, ternary-thunk-style\)/.test(r1.out), true);
    const p2 = readFileSync(f, "utf8");
    execFileSync("node", ["--check", f]);
    check("ternary: patched fixture passes node --check", true, true);
    const r2 = runPatch(f);
    check("ternary: second run exits 0", r2.status, 0);
    check("ternary: second run reports B already patched", /B already patched/.test(r2.out), true);
    check("ternary: second run leaves the file byte-identical", readFileSync(f, "utf8") === p2, true);
    const run = (src, home) => {
      const sandbox = { process: { platform: "linux", env: home === undefined ? {} : { HOME: home } }, require: createRequire(import.meta.url), __pm: null };
      vm.runInNewContext(src + "\n;__pm=new Pm;", vm.createContext(sandbox));
      return (entry, cwd) => {
        const out = sandbox.__pm.res("foo@market", entry, { "foo@market": true }, {}, cwd);
        return out.plugin ? out.plugin.scope : out.otherFolderPlugin ? "other:" + out.otherFolderPlugin.scope : "skipped";
      };
    };
    const before = run(FIX2, HOME), after = run(p2, HOME), noHome = run(p2, undefined);
    check("ternary unpatched: project@$HOME, cwd below $HOME", before(proj(HOME), "/home/u/work"), "project");
    check("ternary unpatched: project@$HOME, cwd elsewhere", before(proj(HOME), "/srv/x"), "other:project");
    check("ternary patched: project@$HOME, cwd below $HOME", after(proj(HOME), "/home/u/work"), "user");
    check("ternary patched: project@$HOME, cwd elsewhere", after(proj(HOME), "/srv/x"), "user");
    check("ternary patched: user scope", after({ scope: "user" }, "/srv/x"), "user");
    check("ternary patched: real project, cwd inside", after(proj("/home/u/work"), "/home/u/work/a"), "project");
    check("ternary patched: real project, cwd outside", after(proj("/home/u/work"), "/srv/x"), "other:project");
    check("ternary patched: local@$HOME stays local", after({ scope: "local", projectPath: HOME }, "/home/u/work"), "local");
    check("ternary patched, HOME unset: project@/home/u keeps project scope", noHome(proj(HOME), "/home/u/work"), "project");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  - " + f);
  dumpPatchRuns();
  process.exit(1);
}
