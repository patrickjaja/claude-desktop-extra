#!/usr/bin/env node
// patches/core/fix_profile_os_entry_points.nim: a named profile's
// os-entry-points.json stays in its own directory.
//
// WHY THIS EXISTS
// ---------------
// Upstream writes os-entry-points.json ({enabled, account, org}: what the
// GNOME search provider shows) to its 1P data directory resolver, which maps
// every userData that does not end in "-3p" to join(appData, "Claude"): the
// default profile's directory. A named profile (--user-data-dir
// ~/.config/Claude-<name>) overwrote the default profile's file with its own
// account and org ids. The patch sends that one write to the active profile's
// userData minus a trailing "-3p", and leaves the resolver alone.
//
// This harness runs the compiled patch on a scratch copy of the pristine chunk
// that holds the writer and pins:
//   [1] the patch applies once, a second run changes nothing (idempotent);
//   [2] the patched writer, run with a fake app.getPath on Linux:
//       /x/Claude -> /x/Claude, /x/Claude-3p -> /x/Claude,
//       /x/Claude-glive -> /x/Claude-glive, /x/Claude-glive-3p ->
//       /x/Claude-glive; CLAUDE_E2E_1P_USERDATA keeps priority; another
//       platform keeps upstream's directory; upstream's own writer sent the
//       named profile to /x/Claude (the defect);
//   [3] nothing else changed: the patched chunk minus our expression is the
//       pristine chunk, so the resolver and its other consumers (3P config,
//       log directory) are byte-identical.
// CDB_BUNDLE_DIR points at another extract, CDB_PATCH_BIN at another compiled
// patch. Without an extract or the binary the harness exits 3 (skipped).
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = process.env.CDB_PATCH_BIN || path.join(ROOT, "patches", "core", "fix_profile_os_entry_points");
const BUILD_DIR = path.join(process.env.CDB_BUNDLE_DIR || path.join(ROOT, "tmp", "app.asar.contents"), ".vite", "build");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra !== undefined ? "  -> " + extra : "")); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
}
const J = JSON.stringify;

try { accessSync(BIN, constants.X_OK); } catch { console.log("SKIP: " + BIN + " not compiled (cd patches && make)"); process.exit(3); }
const chunk = existsSync(BUILD_DIR) ? readdirSync(BUILD_DIR).filter((f) => /^index.*\.js$/.test(f)).find((f) => readFileSync(path.join(BUILD_DIR, f), "utf8").includes("os-entry-points.json")) : null;
if (!chunk) { console.log("SKIP: no extract with os-entry-points.json under " + BUILD_DIR); process.exit(3); }

const scratch = mkdtempSync(path.join(os.tmpdir(), "cdb-os-entry-points-"));
process.on("exit", () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

// Brace-balanced cut of `function NAME(` (with a leading `async `) out of src.
function cutFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  const from = src.slice(Math.max(0, at - 6), at) === "async " ? at - 6 : at;
  let depth = 0;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(from, j + 1);
  }
  throw new Error("unbalanced " + name);
}

// ── [1] apply ──────────────────────────────────────────────────────────────
console.log("\n[1] the patch applies once");
const pristine = readFileSync(path.join(BUILD_DIR, chunk), "utf8");
const staged = path.join(scratch, "index.js");
writeFileSync(staged, pristine);
const r1 = spawnSync(BIN, [staged], { encoding: "utf8" });
ok(r1.status === 0 && /\[OK\] os-entry-points\.json: written to the active profile's directory/.test(r1.stdout), "applies", r1.status + " " + r1.stdout.split("\n").filter((l) => /OK|FAIL/.test(l)).join(" | "));
const patched = readFileSync(staged, "utf8");
const r2 = spawnSync(BIN, [staged], { encoding: "utf8" });
ok(r2.status === 0 && /already written to the active profile's directory \(idempotent\)/.test(r2.stdout) && readFileSync(staged, "utf8") === patched, "second run: the injected end state is found, nothing changes", r2.stdout.split("\n").filter((l) => /OK|FAIL/.test(l)).join(" | "));
const noWriter = path.join(scratch, "nowriter.js");
const nameVar = /[\s,;]([\w$]+)=["`]os-entry-points\.json["`][,;]/.exec(pristine)[1];
const joinSite = new RegExp("\\.join\\(([\\w$]+\\(\\)," + nameVar.replace(/\$/g, "\\$") + "\\))");
ok(joinSite.test(pristine), "the writer's join(TJe(), VIo) is in the pristine chunk");
writeFileSync(noWriter, pristine.replace(joinSite, ".join( $1"));
const r3 = spawnSync(BIN, [noWriter], { encoding: "utf8" });
ok(r3.status !== 0 && /\[FAIL\] os-entry-points writer/.test(r3.stdout), "a writer that changed shape: [FAIL], exit non-zero", r3.stdout.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));

// ── [2] the patched writer ─────────────────────────────────────────────────
console.log("\n[2] the directory it writes to");
const writerName = (src) => {
  const re = new RegExp("async function ([\\w$]+)\\([\\w$]+\\)\\{let [\\w$]+=JSON\\.stringify\\([\\w$]+\\);[^}]*?\\.join\\([\\s\\S]{0,400}?," + nameVar.replace(/\$/g, "\\$") + "\\),");
  return re.exec(src)[1];
};
const wName = writerName(patched);
const wPatched = cutFn(patched, wName), wPristine = cutFn(pristine, wName);
const inj = /\/\*__cdbOsEntryProfile\*\/\(process\.platform==="linux"\?([\w$]+)\("CLAUDE_E2E_1P_USERDATA"\)\|\|\(__cdbU=>__cdbU\.endsWith\(([\w$]+)\)\?__cdbU\.slice\(0,-\2\.length\):__cdbU\)\(([\w$]+)\.app\.getPath\("userData"\)\):([\w$]+)\(\)\)/.exec(wPatched);
ok(!!inj, "the writer carries the injected expression", inj && inj[0]);
const [, envFn, suffix, electron, dirFn] = inj;
// The writer's free names: write helper, path binding, cache.
const m = /async function [\w$]+\(([\w$]+)\)\{let ([\w$]+)=JSON\.stringify\(\1\);\2!==([\w$]+)&&\(await ([\w$]+)\(([\w$]+)(?:\.default)?\.join\(/.exec(wPatched);
const [, , , cacheVar, writeFn, pathVar] = m;
// Upstream's resolver chain, cut verbatim (its other consumers use it).
const resolver = /function ([\w$]+)\(\)\{let ([\w$]+)=([\w$]+)\(["`]CLAUDE_E2E_1P_USERDATA["`]\)/.exec(pristine)[1];
function runWriter(src, { userData, appData = "/x", platform = "linux", e2e } = {}) {
  const writes = [];
  const free = {
    [writeFn]: async (p) => { writes.push(p); },
    [pathVar]: { join: path.posix.join, default: path.posix },
    [electron]: { app: { getPath: (k) => k === "userData" ? userData : k === "appData" ? appData : "/unexpected" } },
    [envFn]: (k) => k === "CLAUDE_E2E_1P_USERDATA" ? e2e : void 0,
    [suffix]: "-3p",
    // Upstream's directory function: the resolver's first entry (Linux shape).
    [dirFn]: () => { const t = userData; return t.endsWith("-3p") ? t.slice(0, -3) : path.posix.join(appData, "Claude"); },
    [cacheVar]: void 0,
    [nameVar]: "os-entry-points.json",
  };
  const names = Object.keys(free);
  const fn = new Function("process", ...names, "return (" + src + ");")({ platform, env: {} }, ...names.map((k) => free[k]));
  return fn({ enabled: true, account: "a", org: "o" }).then(() => writes[0]);
}
const cases = [["/x/Claude", "/x/Claude"], ["/x/Claude-3p", "/x/Claude"], ["/x/Claude-glive", "/x/Claude-glive"], ["/x/Claude-glive-3p", "/x/Claude-glive"]];
for (const [ud, want] of cases) {
  const got = await runWriter(wPatched, { userData: ud });
  ok(got === want + "/os-entry-points.json", `Linux, userData ${ud}: ${want}/os-entry-points.json`, got);
}
const up = await runWriter(wPristine, { userData: "/x/Claude-glive" });
ok(up === "/x/Claude/os-entry-points.json", "(upstream's writer: the named profile wrote the default profile's file)", up);
const e2e = await runWriter(wPatched, { userData: "/x/Claude-glive", e2e: "/e2e/data" });
ok(e2e === "/e2e/data/os-entry-points.json", "CLAUDE_E2E_1P_USERDATA keeps priority", e2e);
const win = await runWriter(wPatched, { userData: "/x/Claude-glive", platform: "win32" });
ok(win === "/x/Claude/os-entry-points.json", "another platform: upstream's directory function, unchanged", win);
// The resolver itself (cut from the pristine chunk) still maps a named profile
// to the default directory: its consumers are not ours to change.
const resolverSrc = cutFn(pristine, resolver);
const resFn = new Function("process", envFn, electron, pathVar, suffix, "Cu", "SJe", "return (" + resolverSrc.replace(/,[\w$]+\)\]\}$/, ",Cu)]}") + ");")(
  { platform: "linux" }, () => void 0, { app: { getPath: (k) => k === "userData" ? "/x/Claude-glive" : "/x" } }, { join: path.posix.join }, "-3p", "Claude", () => ({}));
ok(J(resFn()) === J(["/x/Claude"]), "the resolver (other consumers: 3P config, logs) is upstream's: a named profile still maps to /x/Claude there", J(resFn()));

// ── [3] nothing else changed ───────────────────────────────────────────────
console.log("\n[3] only the writer's directory changed");
const back = patched.replace(inj[0], dirFn + "()");
ok(back === pristine, "patched chunk minus the injected expression = the pristine chunk");
ok(patched.split("__cdbOsEntryProfile").length === 2, "one injection");
for (const fnName of [resolver, dirFn]) ok(cutFn(patched, fnName) === cutFn(pristine, fnName), `function ${fnName} byte-identical`);
const otherUse = new RegExp("[^\\w$.]" + dirFn.replace(/\$/g, "\\$") + "\\(\\)", "g");
ok((pristine.match(otherUse) || []).length === (patched.match(otherUse) || []).length, `${dirFn}() keeps its other consumer(s); the writer's call moved behind the Linux test`, (pristine.match(otherUse) || []).length + " -> " + (patched.match(otherUse) || []).length);
ok(!new RegExp("[^\\w$.]" + nameVar.replace(/\$/g, "\\$") + "[^\\w$]").test(pristine.replace(new RegExp("[\\s,;]" + nameVar.replace(/\$/g, "\\$") + "=[\"`]os-entry-points\\.json[\"`]"), "").replace(new RegExp("\\.join\\(" + dirFn.replace(/\$/g, "\\$") + "\\(\\)," + nameVar.replace(/\$/g, "\\$") + "\\)"), "")), "nothing in the app reads the file back (the name is only declared and written)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
