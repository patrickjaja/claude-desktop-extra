#!/usr/bin/env node
// Computer Use on Linux: claude.ai's task-end event reaches the Linux executor.
//
// WHY THIS EXISTS
// ---------------
// The claude.ai renderer calls main's `releaseRemoteCuLock(id, source)` IPC on a
// cloud session's running->idle edge, on Stop ("stop_click"), on archive and on
// delete (3.6556.2: `releaseRemoteCuLock:(e,t)=>{pBi(e??void 0,t==="stop_click"?
// "stop_click":"renderer")}`). Upstream ignores it when the id differs from the
// CU lock's holder byte for byte, although one session has two ids (session_X /
// cse_X), so the Linux portal session stayed up after the task ended (#293).
//
// Sub-patch 4e of fix_computer_use_linux.nim injects, before upstream's call:
//   try{process.platform==="linux"&&globalThis.__linuxExecutor?.__cuTaskBoundary
//     ?.(<id>??void 0,<source>,exports.<lockKey>.currentHolder)?.catch?.(log)}
//   catch(r){log}
// where exports.<lockKey> is the lock module's own export getter for upstream's
// CU lock instance (`aJ`, exported as `ZC` in 3.6556.2), found in the same chunk.
//
// This harness stages the real extract under tmp/app.asar.contents/ exactly as
// the orchestrator does, runs the compiled patch binary on it (twice), and pins:
//   [1] the pristine anchors: the handler, the lock instance and its export
//       getter, all once and in the same chunk; no hook yet.
//   [2] the patch applies with its full counter, reports 4e, and is idempotent.
//   [3] the injected call lands once and passes id, source and the holder read
//       through the lock's export getter; the changed chunk passes node --check.
//   [4] the patched handler, evaluated in a vm sandbox: the hook receives the
//       args before upstream's call runs; upstream's call always runs, also when
//       the hook throws or rejects or is missing; off Linux nothing is called.
//   [5] sub-patch 4b hands the new holder (`__setLockHeld?.(!0,<holder>)`) and
//       sub-patch 4f exposes upstream's remote-session status accessor as
//       globalThis.__cdbRemoteSessionMode on Linux only (#293): the pristine
//       accessor and the `ended` expression of refreshRemoteChromeSessionMode
//       (with worker_status==="idle") are pinned, the injection lands once
//       right after the accessor, is a positive end-state marker (a bundle
//       missing only it is refused as half-patched), and passes node --check.
//       4.4212.0: accessor `ner` in index.chunk-CvhJZ02X.js, the status check
//       in index.chunk-CL5khZ71.js; its result keys are ok / transient /
//       notFound on failure and ok / ended / coworkRemote / ... on success.
//   [6] both executors log the lock hook's holder on entry.
//   [7] sub-patch 4h: upstream's turn-end unhide (unhideComputerUseApps, 4.4212.0
//       `Z9i` in index.chunk-CvhJZ02X.js) calls the Linux executor's
//       __unhideApps(ids) when it has one, else upstream's own Linux arm; the
//       pristine anchor once, the routing once and node --check'ed, refusal of
//       a bundle missing only 4h and of a moved Linux arm, the patched function
//       in a vm sandbox per platform, and the upstream turn-end callers pinned.
// Sections SKIP when the binary or the extract is missing. CDB_CU_PATCH_BIN
// points at another compiled binary (e.g. master's, to see the harness fail).
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  accessSync,
  constants,
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_SRC = join(repo, "patches", "linux", "fix_computer_use_linux.nim");
const PATCH_BIN =
  process.env.CDB_CU_PATCH_BIN || join(repo, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = join(
  process.env.CDB_BUNDLE_DIR || join(repo, "tmp", "app.asar.contents"),
  ".vite",
  "build"
);
const EXPECTED_PATCHES = Number(
  /const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(PATCH_SRC, "utf8"))[1]
);

let pass = 0;
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

// Upstream's handler (quote style may flip between releases) and our hook.
const PRISTINE_HANDLER_RE =
  /releaseRemoteCuLock:\(([\w$]+),([\w$]+)\)=>\{([\w$]+)\(\1\?\?void 0,\2===(["`])stop_click\4\?\4stop_click\4:\4renderer\4\)\}/;
const PATCHED_HANDLER_RE =
  /releaseRemoteCuLock:(\(([\w$]+),([\w$]+)\)=>\{try\{process\.platform==="linux"&&globalThis\.__linuxExecutor\?\.__cuTaskBoundary\?\.\(\2\?\?void 0,\3==="stop_click"\?"stop_click":"renderer",exports\.([\w$]+)\.currentHolder\)\?\.catch\?\.\([^{}]*\)\}catch\([\w$]+\)\{[^{}]*\}([\w$]+)\(\2\?\?void 0,\3===(["`])stop_click\6\?\6stop_click\6:\6renderer\6\)\})/;
const LOCK_DECL_RE = /(?<![\w$.])([\w$]+)=new class extends [\w$]+(?:\.[\w$]+)*\{/g;
const HOLDER_GETTER = "get currentHolder(){return this.exclusiveHolder}";
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
// 4b / 4f (#293).
const ACQUIRE_RE = /return this\.exclusiveHolder=([\w$]+),(?:this\.[\w$]+\+\+,)*/;
const LOCK_HELD_TRUE_RE = /__setLockHeld\?\.\(!0,([\w$]+)\)\.catch\?\.\(/g;
const ACCESSOR_RE =
  /async function ([\w$]+)\(\)\{([^{}]{0,400})return\{resolve:([\w$]+)\.resolveRemoteChromeSessionMode,refresh:\3\.refreshRemoteChromeSessionMode\}\}/g;
const ACCESSOR_PATCHED_RE =
  /async function ([\w$]+)\(\)\{[^{}]{0,400}return\{resolve:([\w$]+)\.resolveRemoteChromeSessionMode,refresh:\2\.refreshRemoteChromeSessionMode\}\}(process\.platform==="linux"&&\(globalThis\.__cdbRemoteSessionMode=([\w$]+)\);)/g;
// 4.4212.0: u=o.status==="archived"||o.status==="failed"||o.worker_status==="idle"||
//   o.worker_status==="running"&&o.connection_status==="disconnected"
const ENDED_RE =
  /(?<![\w$.])([\w$]+)=([\w$]+)\.status===(["`])archived\3\|\|\2\.status===\3failed\3\|\|\2\.worker_status===\3idle\3\|\|\2\.worker_status===\3running\3&&\2\.connection_status===\3disconnected\3[,;]/g;

function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"];
  const bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) {
    names.push(pieces[i]);
    bodies.push(pieces[i + 1]);
  }
  return { names, bodies };
}

// The CU lock instance (class body holds the holder getter) and its export key.
function lockInPart(body) {
  const names = [];
  for (const m of body.matchAll(LOCK_DECL_RE)) {
    const start = m.index + m[0].length;
    let end = body.indexOf("=new class ", start);
    if (end === -1) end = body.length;
    const g = body.indexOf(HOLDER_GETTER, start);
    if (g !== -1 && g < end) names.push(m[1]);
  }
  if (names.length !== 1) return { names };
  const esc = names[0].replace(/\$/g, "\\$");
  const exportRe = new RegExp(
    'Object\\.defineProperty\\(exports,(["`])([A-Za-z_$][\\w$]*)\\1,\\{enumerable:!0,get:function\\(\\)\\{return ' +
      esc +
      "\\}\\}\\)",
    "g"
  );
  const keys = [...body.matchAll(exportRe)].map((m) => m[2]);
  return { names, keys };
}

// --- the rig ------------------------------------------------------------------
// Evaluate the patched handler arrow in a fresh context: `process`, `exports`,
// upstream's release function and the executor stub are what the real chunk
// scope provides at that site.
function makeHandler(arrowSrc, upstreamFn, lockKey, opts) {
  const calls = [];
  const diag = [];
  let holderReads = 0;
  const exportsObj = {};
  Object.defineProperty(exportsObj, lockKey, {
    get() {
      holderReads++;
      return { currentHolder: opts.holder };
    },
  });
  const ctx = {
    process: { platform: opts.platform },
    exports: exportsObj,
    console: { warn: (...a) => diag.push(["console.warn", ...a]) },
    __cdbDiag: (...a) => diag.push(a),
  };
  ctx[upstreamFn] = (...a) => calls.push(["upstream", ...a]);
  if (opts.executor !== undefined) ctx.__linuxExecutor = opts.executor(calls);
  vm.createContext(ctx);
  const fn = vm.runInContext("(" + arrowSrc + ")", ctx);
  return { fn, calls, diag, holderReads: () => holderReads };
}
const recordingExecutor = (calls) => ({
  __cuTaskBoundary: (...a) => {
    calls.push(["boundary", ...a]);
  },
});

let skipped = false;
let patchMissing = false;
try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  patchMissing = true;
}
const stub = join(BUILD_DIR, "index.js");
if (patchMissing || !existsSync(stub)) {
  skipped = true;
  console.log(
    "\n  SKIP real-bundle sections: " +
      (patchMissing
        ? `${PATCH_BIN} is not compiled (run: make -C patches linux/fix_computer_use_linux)`
        : "no extract under tmp/app.asar.contents/ (set CDB_BUNDLE_DIR to point at one)")
  );
} else {
  const scratch = mkdtempSync(join(tmpdir(), "cdb-cu-task-boundary-"));
  try {
    // Stage exactly as the orchestrator does: stub + every index*.chunk-*
    // sibling as ONE file, each sibling preceded by its boundary marker.
    const chunks = readdirSync(BUILD_DIR)
      .filter((d) => /^index.*\.chunk-.*\.js$/.test(d))
      .sort();
    const originals = new Map([["index.js", readFileSync(stub, "utf8")]]);
    let blob = originals.get("index.js");
    for (const c of chunks) {
      const body = readFileSync(join(BUILD_DIR, c), "utf8");
      originals.set(c, body);
      blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + body;
    }
    const staged = join(scratch, "staged_index.js");
    writeFileSync(staged, blob);

    console.log("\n[1] pristine anchors in the staged bundle");
    check("pristine handler present once", countRe(blob, PRISTINE_HANDLER_RE), 1);
    check("no __cuTaskBoundary hook yet", count(blob, "__cuTaskBoundary"), 0);
    const pristine = splitParts(blob);
    const hIdx = pristine.bodies.findIndex((b) => PRISTINE_HANDLER_RE.test(b));
    check("handler found in a chunk part", hIdx >= 0, true);
    const lock = hIdx >= 0 ? lockInPart(pristine.bodies[hIdx]) : { names: [] };
    check("CU lock instance in the handler's chunk", lock.names.length, 1);
    check("its export getter in the same chunk", (lock.keys || []).length, 1);
    console.log(
      `  (handler in ${pristine.names[hIdx]}, lock ${lock.names[0]}, exported as ${(lock.keys || [])[0]})`
    );

    console.log("\n[2] the compiled patch applies with the full counter, then is idempotent");
    const run = () => {
      const r = spawnSync(PATCH_BIN, [staged], { encoding: "utf8" });
      return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
    };
    const r1 = run();
    check("first run exits 0", r1.status, 0);
    check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
    check(
      `[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} reported`,
      r1.out.includes(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} sub-patches applied`),
      true
    );
    check(
      "4e reported [OK] with the lock's export key",
      /\[OK\] 4e task boundary: releaseRemoteCuLock hands id, source and holder \(exports\.[\w$]+ = [\w$]+\) to the Linux executor \(1 match\)/.test(
        r1.out
      ),
      true
    );
    if (r1.status !== 0) console.log(r1.out);
    const patched = readFileSync(staged, "utf8");
    const r2 = run();
    check("second run exits 0", r2.status, 0);
    check(
      "second run reports every end-state marker present",
      /\[OK\] all \d+ end-state markers already present \(idempotent, no change\)/.test(r2.out),
      true
    );
    check("second run leaves the file byte-identical", readFileSync(staged, "utf8") === patched, true);

    console.log("\n[3] the injected call");
    check("__cuTaskBoundary call present once", count(patched, "__cuTaskBoundary?.("), 1);
    check("patched handler shape present once", countRe(patched, PATCHED_HANDLER_RE), 1);
    check("pristine handler shape gone", countRe(patched, PRISTINE_HANDLER_RE), 0);
    const pm = PATCHED_HANDLER_RE.exec(patched);
    const [, arrowSrc, idP, srcP, key, upstreamFn] = pm || [];
    const pristineM = PRISTINE_HANDLER_RE.exec(blob) || [];
    check("passes upstream's id param (??void 0)", idP, pristineM[1]);
    check("passes upstream's source param", srcP, pristineM[2]);
    check("upstream's call is the same function", upstreamFn, pristineM[3]);
    check("holder read through the lock's own export key", key, (lock.keys || [])[0]);
    const after = splitParts(patched);
    const pIdx = after.bodies.findIndex((b) => PATCHED_HANDLER_RE.test(b));
    check("hook lands in the handler's own chunk", after.names[pIdx], pristine.names[hIdx]);
    if (pIdx >= 0) {
      const f = join(scratch, after.names[pIdx]);
      writeFileSync(f, after.bodies[pIdx]);
      let ok = true;
      try {
        execFileSync("node", ["--check", f], { stdio: "pipe" });
      } catch {
        ok = false;
      }
      check(`node --check ${after.names[pIdx]}`, ok, true);
    }

    console.log("\n[4] the patched handler in a vm sandbox");
    if (!pm) {
      check("patched handler extracted", false, true);
    } else {
      // a. Linux, idle edge: hook first with (id, "renderer", holder), then upstream.
      let h = makeHandler(arrowSrc, upstreamFn, key, {
        platform: "linux",
        holder: "cse_ABC",
        executor: recordingExecutor,
      });
      let ret = h.fn("session_ABC", null);
      check("returns undefined (no return-value use)", ret, undefined);
      check(
        "linux renderer: hook then upstream",
        JSON.stringify(h.calls),
        JSON.stringify([
          ["boundary", "session_ABC", "renderer", "cse_ABC"],
          ["upstream", "session_ABC", "renderer"],
        ])
      );

      // b. Stop.
      h = makeHandler(arrowSrc, upstreamFn, key, {
        platform: "linux",
        holder: "cse_ABC",
        executor: recordingExecutor,
      });
      h.fn("cse_ABC", "stop_click");
      check(
        "linux stop_click: source passed to both",
        JSON.stringify(h.calls),
        JSON.stringify([
          ["boundary", "cse_ABC", "stop_click", "cse_ABC"],
          ["upstream", "cse_ABC", "stop_click"],
        ])
      );

      // c. No id, no holder.
      h = makeHandler(arrowSrc, upstreamFn, key, {
        platform: "linux",
        holder: undefined,
        executor: recordingExecutor,
      });
      h.fn(null, "archive");
      check("null id arrives as undefined", h.calls[0].length === 4 && h.calls[0][1] === undefined, true);
      check("unknown source maps to renderer", h.calls[0][2], "renderer");
      check("undefined holder passed through", h.calls[0][3], undefined);
      check("upstream still runs", h.calls.length === 2 && h.calls[1][0] === "upstream", true);

      // d. A throwing hook does not break upstream's call.
      h = makeHandler(arrowSrc, upstreamFn, key, {
        platform: "linux",
        holder: "x",
        executor: () => ({
          __cuTaskBoundary: () => {
            throw new Error("boom");
          },
        }),
      });
      let threw = false;
      try {
        h.fn("x", "stop_click");
      } catch {
        threw = true;
      }
      check("throwing hook: handler does not throw", threw, false);
      check(
        "throwing hook: upstream still runs",
        JSON.stringify(h.calls),
        JSON.stringify([["upstream", "x", "stop_click"]])
      );
      check("throwing hook: logged", h.diag.length === 1 && String(h.diag[0][0]).includes("task boundary"), true);

      // e. A rejecting async hook does not break upstream's call or go unhandled.
      let unhandled = 0;
      const onUnhandled = () => unhandled++;
      process.on("unhandledRejection", onUnhandled);
      h = makeHandler(arrowSrc, upstreamFn, key, {
        platform: "linux",
        holder: "x",
        executor: () => ({ __cuTaskBoundary: async () => Promise.reject(new Error("async boom")) }),
      });
      h.fn("x", null);
      await new Promise((r) => setTimeout(r, 10));
      process.off("unhandledRejection", onUnhandled);
      check("rejecting hook: upstream still runs", JSON.stringify(h.calls), JSON.stringify([["upstream", "x", "renderer"]]));
      check("rejecting hook: rejection logged", h.diag.length === 1, true);
      check("rejecting hook: no unhandled rejection", unhandled, 0);

      // f. No executor / no method on Linux.
      for (const [label, executor] of [
        ["no __linuxExecutor", undefined],
        ["executor without __cuTaskBoundary", () => ({})],
      ]) {
        h = makeHandler(arrowSrc, upstreamFn, key, { platform: "linux", holder: "x", executor });
        threw = false;
        try {
          h.fn("x", null);
        } catch {
          threw = true;
        }
        check(`${label}: no throw, upstream runs`, !threw && h.calls.length === 1 && h.calls[0][0] === "upstream", true);
      }

      // g. Off Linux nothing of ours is evaluated.
      for (const platform of ["darwin", "win32"]) {
        h = makeHandler(arrowSrc, upstreamFn, key, {
          platform,
          holder: "x",
          executor: recordingExecutor,
        });
        h.fn("x", "stop_click");
        check(
          `${platform}: hook not called, upstream runs`,
          JSON.stringify(h.calls),
          JSON.stringify([["upstream", "x", "stop_click"]])
        );
        check(`${platform}: lock export not read`, h.holderReads(), 0);
      }
    }

    console.log("\n[5] 4b hands the holder, 4f exposes the session check accessor (#293)");
    // Pristine side.
    const acq = ACQUIRE_RE.exec(blob) || [];
    check("pristine lock acquire assigns a holder", acq.length > 1, true);
    check("pristine: no __setLockHeld yet", count(blob, "__setLockHeld"), 0);
    const accessors = [...blob.matchAll(ACCESSOR_RE)];
    check("pristine accessor (resolve/refresh pair) present once", accessors.length, 1);
    const accName = accessors[0]?.[1];
    check("pristine accessor body require()s the session module", /require\(/.test(accessors[0]?.[2] || ""), true);
    check("pristine: no __cdbRemoteSessionMode yet", count(blob, "__cdbRemoteSessionMode"), 0);
    const statusIdx = pristine.bodies.findIndex((b) => /refreshRemoteChromeSessionMode:\(\)=>[\w$]+/.test(b));
    check("chunk exporting refreshRemoteChromeSessionMode found", statusIdx >= 0, true);
    const statusPart = statusIdx >= 0 ? pristine.bodies[statusIdx] : "";
    const endedM = [...statusPart.matchAll(ENDED_RE)];
    check('`ended` expression (worker_status==="idle" ...) present once', endedM.length, 1);
    const endedVar = endedM[0]?.[1] || "\u0000";
    const esc = (x) => x.replace(/\$/g, "\\$");
    check(
      "success result {ok:!0,...,ended:<that expression>,coworkRemote:...}",
      countRe(statusPart, new RegExp("\\{ok:!0,[^{}]*?,ended:" + esc(endedVar) + ",coworkRemote:")),
      1
    );
    check("transient result {ok:!1,transient:!0} present", count(statusPart, "{ok:!1,transient:!0}") >= 1, true);
    check("notFound result {ok:!1,notFound:!0} present", count(statusPart, "{ok:!1,notFound:!0}") >= 1, true);
    console.log(
      `  (accessor ${accName} in ${pristine.names[pristine.bodies.findIndex((b) => b.includes("refresh:" + (accessors[0]?.[3] || "\u0000") + ".refreshRemoteChromeSessionMode}}"))]}, status check in ${pristine.names[statusIdx]}, ended = ${endedVar})`
    );

    // Patch log.
    check(
      "4b reported [OK] (hands the holder)",
      /\[OK\] 4b cu lock acquire: start bridge session on Linux, hand over the holder \(1 match\)/.test(r1.out),
      true
    );
    check(
      "4f reported [OK] with the accessor name (1 match)",
      new RegExp(
        "\\[OK\\] 4f session check accessor: " + esc(accName || "\u0000") +
          " exposed as globalThis\\.__cdbRemoteSessionMode on Linux \\(1 match\\)"
      ).test(r1.out),
      true
    );

    // Patched side: 4b.
    const held = [...patched.matchAll(LOCK_HELD_TRUE_RE)];
    check("__setLockHeld?.(!0,<holder>) present once", held.length, 1);
    check("the holder passed is the one acquire() assigns", held[0]?.[1], acq[1]);
    check("no holder-less __setLockHeld?.(!0) left", count(patched, "__setLockHeld?.(!0)"), 0);
    check("release still __setLockHeld?.(!1) (twice)", count(patched, "__setLockHeld?.(!1)"), 2);

    // Patched side: 4f.
    check("globalThis.__cdbRemoteSessionMode= present once", count(patched, "globalThis.__cdbRemoteSessionMode="), 1);
    const exposed = [...patched.matchAll(ACCESSOR_PATCHED_RE)];
    check("assignment sits right after the accessor", exposed.length, 1);
    check("assigned name is the accessor itself", exposed[0]?.[4], accName);
    check("accessor named in the assignment is the declared one", exposed[0]?.[1], accName);
    const accIdx = after.bodies.findIndex((b) => b.includes("globalThis.__cdbRemoteSessionMode="));
    if (accIdx >= 0 && accIdx !== pIdx) {
      const f = join(scratch, after.names[accIdx]);
      writeFileSync(f, after.bodies[accIdx]);
      let ok = true;
      try {
        execFileSync("node", ["--check", f], { stdio: "pipe" });
      } catch {
        ok = false;
      }
      check(`node --check ${after.names[accIdx]}`, ok, true);
    } else {
      // Same chunk as the handler: node --check ran on it in [3].
      check("accessor chunk located (node --check'ed in [3])", accIdx >= 0, true);
    }
    // The injected statement: assigns on Linux only.
    if (exposed[0]) {
      for (const [platform, want] of [
        ["linux", "function"],
        ["darwin", "undefined"],
        ["win32", "undefined"],
      ]) {
        const ctx = { process: { platform } };
        vm.createContext(ctx);
        vm.runInContext(`async function ${accName}(){return 1}` + exposed[0][3], ctx);
        check(`${platform}: __cdbRemoteSessionMode is ${want}`, typeof ctx.__cdbRemoteSessionMode, want);
      }
    }

    // Idempotency is a positive end state: the second run above saw 4f's marker;
    // a bundle that has everything but 4f's injection is refused, not re-patched.
    const missing4f = join(scratch, "missing_4f.js");
    writeFileSync(missing4f, exposed[0] ? patched.replace(exposed[0][3], "") : patched);
    const r3 = spawnSync(PATCH_BIN, [missing4f], { encoding: "utf8" });
    const out3 = String(r3.stdout || "") + String(r3.stderr || "");
    check("bundle without 4f's injection: patch exits non-zero", r3.status !== 0, true);
    check(
      "bundle without 4f's injection: refused as half-patched, missing 4f",
      /half-patched input: .*missing: 4f session check accessor/.test(out3),
      true
    );

    // [6] the lock hook the patched bundle calls (4b: __setLockHeld(!0,<holder>),
    // 4b.2: __setLockHeld(!1)) logs on entry in both executors (#293 round 9):
    // `lock taken by <holder|none>` / `lock released`, before any early return,
    // so an empty grep proves the hook never arrived. Source-level: both
    // executors are wired to the hook exactly as the patched bundle calls it.
    console.log("\n[6] the executors log the lock hook's holder on entry (#293)");
    const gnomeSrc = readFileSync(join(repo, "js", "cu_linux_executor.js"), "utf8");
    const kwinSrc = readFileSync(join(repo, "js", "executor_linux.js"), "utf8");
    const gBody = gnomeSrc.slice(gnomeSrc.indexOf("async __setLockHeld(held,holder){"));
    const kBody = kwinSrc.slice(kwinSrc.indexOf("async __setLockHeld(isHeld, holder) {"));
    check("GNOME: __setLockHeld(held,holder) present", gBody.length < gnomeSrc.length, true);
    check("KWin: __setLockHeld(isHeld, holder) present", kBody.length < kwinSrc.length, true);
    const gLog = gBody.indexOf('"[claude-cu] "+(held?"lock taken by "+');
    const gRet = gBody.search(/\breturn\b/);
    check("GNOME: lock line logged through __cdbDiag before the first return", gLog > 0 && gLog < gRet, true);
    const kLog = kBody.indexOf("[claude-cu] ${isHeld ? `lock taken by ");
    const kRet = kBody.search(/\breturn\b/);
    check("KWin: lock line logged before the first return", kLog > 0 && kLog < kRet, true);
    check("KWin: the lock line does not go through debugLog/console.debug", /globalThis\.__cdbDiag\?\.\(`\[claude-cu\] \$\{isHeld/.test(kBody), true);
    check("both: 'lock released' text", gBody.includes('"lock released"') && kBody.includes("'lock released'"), true);
    // Run both __setLockHeld lock lines against a stub diag with the holder the
    // patched call site passes (a string) and with none (4b.2's release).
    const lines = [];
    const lockLine = (src, rx) => rx.exec(src)?.[0];
    const gExpr = lockLine(gBody, /globalThis\.__cdbDiag\?\.\("\[claude-cu\] "\+\(held\?"lock taken by "\+\(_gnomeHolder\|\|"none"\):"lock released"\)\)/);
    const kExpr = lockLine(kBody, /globalThis\.__cdbDiag\?\.\(`\[claude-cu\] \$\{isHeld \? `lock taken by \$\{typeof holder === 'string' && holder \? holder : 'none'\}` : 'lock released'\}`\)/);
    check("GNOME lock expression extracted", !!gExpr, true);
    check("KWin lock expression extracted", !!kExpr, true);
    for (const [held, holder, want] of [
      [true, "cse_X", "[claude-cu] lock taken by cse_X"],
      [true, undefined, "[claude-cu] lock taken by none"],
      [false, undefined, "[claude-cu] lock released"],
    ]) {
      const out = [];
      const ctx = { globalThis: { __cdbDiag: (m) => out.push(m) }, held, isHeld: held, holder, _gnomeHolder: held && typeof holder === "string" ? holder : null };
      vm.createContext(ctx);
      if (gExpr) vm.runInContext(gExpr, ctx);
      if (kExpr) vm.runInContext(kExpr, ctx);
      check(`held=${held} holder=${holder}: GNOME and KWin log "${want}"`, JSON.stringify(out), JSON.stringify([want, want]));
    }

    // [7] sub-patch 4h: upstream's turn-end unhide reaches the Linux executor.
    // Upstream's unhideComputerUseApps (4.4212.0: `Z9i` in index.chunk-CvhJZ02X.js)
    // always loaded its own Linux executor module on Linux, whose unhide only
    // knows windows upstream's executor hid, so KWin capture exclusions stayed.
    console.log("\n[7] 4h routes upstream's turn-end unhide to the Linux executor");
    const UNHIDE_RE =
      /async function ([\w$]+)\(([\w$]+)\)\{if\(\2\.length!==0\)\{if\(process\.platform===(["`])win32\3\)\{let\{unhideComputerUseAppsWin32:[\w$]+\}=[^{}]{0,300}\}if\(process\.platform===\3linux\3\)\{let\{unhideComputerUseAppsLinux:([\w$]+)\}=[^{}]{0,300}await \4\(\2\);return\}/g;
    const ROUTE = 'if(typeof globalThis.__linuxExecutor?.__unhideApps==="function"){await globalThis.__linuxExecutor.__unhideApps(';
    const unhidePristine = [...blob.matchAll(UNHIDE_RE)];
    check("pristine unhide function present once", unhidePristine.length, 1);
    const unhideFn = unhidePristine[0]?.[1] || "\u0000";
    check("pristine: no __unhideApps routing yet", count(blob, "__unhideApps"), 0);
    check(
      "pristine: the Linux arm loads unhideComputerUseAppsLinux (once in the bundle)",
      count(blob, "{unhideComputerUseAppsLinux:"),
      1
    );
    const uIdx = pristine.bodies.findIndex((b) => b.includes("async function " + unhideFn + "("));
    console.log(`  (unhide function ${unhideFn} in ${pristine.names[uIdx]})`);
    check(
      `4h reported [OK] for ${unhideFn}`,
      new RegExp("\\[OK\\] 4h unhide routing: " + esc(unhideFn) + "'s Linux arm calls the Linux executor's __unhideApps when present \\(1 match\\)").test(r1.out),
      true
    );
    check("routing present once", count(patched, ROUTE), 1);
    check("routing passes upstream's ids param", count(patched, ROUTE + (unhidePristine[0]?.[2] || "\u0000") + ");return}let{unhideComputerUseAppsLinux:"), 1);
    const uAfterIdx = after.bodies.findIndex((b) => b.includes(ROUTE));
    check("routing lands in the unhide function's own chunk", after.names[uAfterIdx], pristine.names[uIdx]);
    if (uAfterIdx >= 0 && uAfterIdx !== pIdx) {
      const f = join(scratch, after.names[uAfterIdx]);
      writeFileSync(f, after.bodies[uAfterIdx]);
      let ok = true;
      try {
        execFileSync("node", ["--check", f], { stdio: "pipe" });
      } catch {
        ok = false;
      }
      check(`node --check ${after.names[uAfterIdx]}`, ok, true);
    }
    // Rule 6: a bundle with everything but 4h's routing is refused.
    const missing4h = join(scratch, "missing_4h.js");
    const routeRe = /if\(typeof globalThis\.__linuxExecutor\?\.__unhideApps==="function"\)\{await globalThis\.__linuxExecutor\.__unhideApps\([\w$]+\);return\}/;
    writeFileSync(missing4h, patched.replace(routeRe, ""));
    const r4h = spawnSync(PATCH_BIN, [missing4h], { encoding: "utf8" });
    const out4h = String(r4h.stdout || "") + String(r4h.stderr || "");
    check("bundle without 4h's routing: exits non-zero", r4h.status !== 0, true);
    check("bundle without 4h's routing: refused as half-patched, missing 4h", /half-patched input: .*missing: 4h unhide routing/.test(out4h), true);
    // A pristine bundle whose Linux arm moved (export renamed) fails loud.
    const moved4h = join(scratch, "unhide_moved.js");
    writeFileSync(moved4h, blob.replace("{unhideComputerUseAppsLinux:", "{unhideComputerUseAppsLinuxV2:"));
    const r4m = spawnSync(PATCH_BIN, [moved4h], { encoding: "utf8" });
    const out4m = String(r4m.stdout || "") + String(r4m.stderr || "");
    check("moved Linux arm: exits non-zero", r4m.status !== 0, true);
    check("moved Linux arm: [FAIL] 4h with 0 matches", /\[FAIL\] 4h unhide routing: 0 matches of upstream's unhide function, expected 1/.test(out4m), true);
    check("moved Linux arm: never reported [PASS]", /\[PASS\]/.test(out4m), false);

    // The patched function in a vm sandbox.
    const fnSrc = (() => {
      const start = patched.indexOf("async function " + unhideFn + "(");
      if (start < 0) return null;
      let depth = 0;
      for (let i = patched.indexOf("{", start); i < patched.length; i++) {
        if (patched[i] === "{") depth++;
        else if (patched[i] === "}" && --depth === 0) return patched.slice(start, i + 1);
      }
      return null;
    })();
    check("patched unhide function extracted", !!fnSrc, true);
    if (fnSrc) {
      const e3Name = /await\(await ([\w$]+)\(\)\)\.apps\.unhide\(/.exec(fnSrc)?.[1];
      check("macOS arm (await(await X()).apps.unhide) kept", !!e3Name, true);
      const runUnhide = async (platform, ids, executor) => {
        const calls = [];
        const ctx = {
          process: { platform },
          Promise,
          require: (id) => {
            calls.push(["require", id]);
            return {
              n: {
                unhideComputerUseAppsLinux: async (x) => calls.push(["upstream-linux", [...x]]),
                unhideComputerUseAppsWin32: async (x) => calls.push(["upstream-win32", [...x]]),
              },
            };
          },
        };
        ctx[e3Name || "e3"] = async () => ({ apps: { unhide: async (x) => calls.push(["upstream-darwin", [...x]]) } });
        if (executor) ctx.__linuxExecutor = executor(calls);
        vm.createContext(ctx);
        let error = null;
        try {
          await vm.runInContext("(" + fnSrc + ")", ctx)(ids);
        } catch (e) {
          error = e;
        }
        return { calls: calls.filter((c) => c[0] !== "require"), required: calls.filter((c) => c[0] === "require").length, error };
      };
      const withUnhide = (calls) => ({ __unhideApps: async (x) => calls.push(["executor", [...x]]) });
      let u = await runUnhide("linux", ["org.kde.dolphin", "firefox"], withUnhide);
      check("linux + executor with __unhideApps: executor gets the ids", JSON.stringify(u.calls), JSON.stringify([["executor", ["org.kde.dolphin", "firefox"]]]));
      check("linux + executor with __unhideApps: upstream's Linux module never loaded", u.required, 0);
      u = await runUnhide("linux", ["firefox"], () => ({}));
      check("linux + executor without __unhideApps: upstream's own Linux arm runs", JSON.stringify(u.calls), JSON.stringify([["upstream-linux", ["firefox"]]]));
      u = await runUnhide("linux", ["firefox"], null);
      check("linux, no executor: upstream's own Linux arm runs", JSON.stringify(u.calls), JSON.stringify([["upstream-linux", ["firefox"]]]));
      u = await runUnhide("linux", ["firefox"], () => ({ __unhideApps: "not a function" }));
      check("linux, __unhideApps not a function: upstream's own Linux arm runs", JSON.stringify(u.calls), JSON.stringify([["upstream-linux", ["firefox"]]]));
      u = await runUnhide("linux", [], withUnhide);
      check("linux, empty ids: nothing called", JSON.stringify(u.calls), "[]");
      u = await runUnhide("win32", ["x"], withUnhide);
      check("win32: upstream's win32 arm, executor untouched", JSON.stringify(u.calls), JSON.stringify([["upstream-win32", ["x"]]]));
      u = await runUnhide("darwin", ["x"], withUnhide);
      check("darwin: upstream's native unhide, executor untouched", JSON.stringify(u.calls), JSON.stringify([["upstream-darwin", ["x"]]]));
      u = await runUnhide("linux", ["x"], () => ({ __unhideApps: async () => { throw new Error("boom"); } }));
      check("linux, a rejecting __unhideApps propagates to upstream's caller (.catch there)", u.error?.message, "boom");
    }

    // The upstream callers: every turn-end path still calls the unhide function
    // behind chicagoAutoUnhide; the KWin executor does not depend on that (it
    // lifts the exclusions on the lock release, below and test-cu-kwin-idle.mjs).
    const unhideExport = new RegExp('([\\w$]+):\\(\\)=>' + esc(unhideFn) + '(?![\\w$])').exec(pristine.bodies[uIdx] || "");
    check("unhide function exported as unhideComputerUseApps", unhideExport?.[1], "unhideComputerUseApps");
    const callerRe = /\.e9\((["`])chicagoAutoUnhide\1\)(?:&&|\?)[\w$]+\.([\w$]+)\(/g;
    const callerExports = new Set([...blob.matchAll(callerRe)].map((m) => m[2]));
    check("turn-end callers (gated on chicagoAutoUnhide) found", [...blob.matchAll(callerRe)].length >= 3, true);
    check("they all call one exported function", callerExports.size, 1);
    const exportKey = [...callerExports][0] || "\u0000";
    const exportGetterRe = new RegExp(
      'Object\\.defineProperty\\(exports,(["`])' + esc(exportKey) + '\\1,\\{enumerable:!0,get:function\\(\\)\\{return ' + esc(unhideFn) + '\\}\\}\\)'
    );
    check(`exports.${exportKey} is ${unhideFn}`, exportGetterRe.test(pristine.bodies[uIdx] || ""), true);
    const lockReleaseRe = /releaseTurnScopedState\([\w$]+\)\{[^{}]{0,120}\.release\([\w$]+\.sessionId\)/;
    check("releaseTurnScopedState releases the CU lock (our 4b.2 hook) before its unhide", lockReleaseRe.test(blob), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) {
  console.log(`${pass} checks passed; real-bundle sections SKIPPED`);
  process.exit(SKIP_EXIT);
}
console.log("ALL " + pass + " CHECKS PASSED");
