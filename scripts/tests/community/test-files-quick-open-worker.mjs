#!/usr/bin/env node
/*
 * test-files-quick-open-worker.mjs - the worker-side helper of the Files quick
 * open feature (js/files_quick_open_worker.js, delivered into upstream's
 * .vite/build/file-index-worker/fileIndexWorker.js by
 * patches/community/add_feature_files_quick_open_worker.nim).
 *
 * Upstream's scorer walks the query char by char with indexOf, so a SPACE has to
 * literally occur in the path: "user service" returned nothing (measured live
 * 2026-08-29 on 1.37937.3). VS Code splits the query on spaces into pieces that
 * must ALL match (fuzzyScorer.ts prepareQuery / doScoreItemFuzzyMultiple). The
 * helper ports that on top of upstream's index without touching its scorer.
 *
 * Part A runs the helper against a FAKE index that reproduces upstream's
 * contract: search(query, limit) -> [{path, score: rank/n, positions}], greedy
 * subsequence, sorted best-first. Part B, when a compiled patch binary and an
 * extracted worker bundle exist locally, patches a copy of the REAL worker and
 * require()s it. Part B is reported as SKIP when either is missing.
 *
 * PART B SKIPS IN CI BY DESIGN. CI runs this harness from a clean checkout with
 * no extracted bundle under tmp/ (the .deb is only unpacked inside the build
 * job's own workspace), so there is nothing to patch and the block prints
 * "SKIP real worker". That is not a coverage hole: in CI the guard against an
 * upstream re-minify is the patch itself, which runs in the build and fails the
 * whole job unless its preconditions hold - the FileIndexHost.search call-site
 * anchor (exactly one hit) and the scorer contract the helper's full-set scan
 * depends on (since v6.28899.2: the index wrapper hands the limit straight to its
 * table, and the table's top-N keeps every match until it holds `limit`; without
 * that multi-piece queries would silently come back truncated). Part B is the LOCAL
 * end-to-end check: run it on a dev box with an extract under tmp/ (see
 * ./scripts/build-local.sh) after any change to the helper or the patch.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, copyFileSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n + (JSON.stringify(a) === JSON.stringify(b) ? "" : " -> got " + JSON.stringify(a)));
const skip = (n, why) => console.log("  SKIP " + n + " -- " + why);

// --- Part A: fake index with upstream's contract --------------------------------
// Greedy leftmost subsequence on the path; fewer/shorter gaps rank higher.
// Returns at most `limit`, best first, score = rank / n. Records calls so the
// single-piece passthrough can be asserted. SMART CASE, like upstream's own
// scorer (`let n = e !== e.toLowerCase(), r = n ? e : e.toLowerCase()` against
// `paths` vs `lowerPaths`, 1.37937.3): a query carrying an uppercase character
// is matched case-sensitively. The helper's ranking follows the same rule, so
// the fake has to model it or the two would be asserted against each other.
// `legacy` adds the v5-era `readyCount`; since v6.28899.2 the count is private
// to upstream's scorer and the helper passes an unbounded limit instead.
function fakeIndex(paths, legacy = false) {
  const calls = [];
  return {
    calls,
    ...(legacy ? { readyCount: paths.length } : {}),
    search(query, limit) {
      calls.push([query, limit]);
      if (limit <= 0) return [];
      const cased = query !== query.toLowerCase();
      const q = cased ? query : query.toLowerCase();
      const hits = [];
      for (const p of paths) {
        const lp = cased ? p : p.toLowerCase(); const pos = []; let from = 0, gaps = 0;
        let okAll = true;
        for (const ch of q) { const i = lp.indexOf(ch, from); if (i < 0) { okAll = false; break; } if (pos.length && i > from) gaps += i - from; pos.push(i); from = i + 1; }
        if (okAll) hits.push({ path: p, gaps, positions: pos });
      }
      hits.sort((a, b) => a.gaps - b.gaps || a.path.length - b.path.length);
      const top = hits.slice(0, limit), n = Math.max(top.length, 1);
      return top.map((h, i) => ({ path: h.path, score: i / n, positions: h.positions }));
    }
  };
}

function loadHelper(envValue) {
  const src = readFileSync(join(ROOT, "js/files_quick_open_worker.js"), "utf8");
  const sandbox = { process: { env: envValue === undefined ? {} : { CDB_FILES_QUICK_OPEN: envValue } }, console };
  vm.runInNewContext(src + "\n;globalThis.__h = __cdbQoSearch;", vm.createContext(sandbox));
  return sandbox.__h;
}

const PATHS = [
  "modules/user/src/tests/user-run/use-cases/user-service.spec.ts",
  "modules/user/src/domain/user-run/factories/user.service.ts",
  "modules/support/src/core/data-provider/providers/abstract.pdf-data-provider.ts",
  "shared/package.json",
  "core/package.json",
  "README.md"
];
const base = (r) => r.path.split("/").pop();
// Upstream's scorer is a subsequence match over the WHOLE relative path, so
// "user" also matches abstract.pdf-data-provider.ts across its directories
// (u in support, s in src, e-r in data-provider), and "spec" aligns as s-p-e-c
// over modules/support/src/core. An AND of pieces must admit those too;
// membership is asserted order-insensitively because the merged rank depends on
// upstream's per-piece scoring, not on us. Module scope: Part B uses them too.
const BOTH = ["abstract.pdf-data-provider.ts", "user-service.spec.ts", "user.service.ts"];
const SPEC = ["abstract.pdf-data-provider.ts", "user-service.spec.ts"];

{
  const h = loadHelper("1");
  const idx = fakeIndex(PATHS);
  eq(h(idx, "user service", 10).map(base).sort(), BOTH,
     "two pieces: every path that is a subsequence match for BOTH pieces (upstream alone returned nothing)");
  eq(h(idx, "service user", 10).map(base).sort(), BOTH,
     "two pieces, REVERSED: same set - pieces are ANDed, not concatenated");
  eq(h(idx, "user service spec", 10).map(base).sort(), SPEC,
     "three pieces narrow to the paths matching all three (user.service.ts has no 'spec' subsequence)");
  eq(h(idx, "shd pkg", 10).map(base), ["package.json"],
     "abbreviated pieces: 'shd' + 'pkg' -> shared/package.json");
  eq(h(idx, "zzz service", 10), [], "a piece that matches nothing empties the result (ALL pieces must match)");

  const r = h(idx, "user service", 10)[0];
  ok(r.positions.every((p, i) => i === 0 || p > r.positions[i - 1]), "positions are strictly ascending (unioned + deduped)");
  ok(typeof r.score === "number" && r.score === 0, "score keeps upstream's rank/n shape (best hit = 0)");
  const three = h(idx, "user service", 10);
  ok(three.length === 3 && three[1].score === 1 / 3 && three[2].score === 2 / 3, "scores are rank/n over the merged set (1/3, 2/3)");
  const one = h(idx, "user service", 1);
  ok(one.length === 1 && BOTH.indexOf(base(one[0])) >= 0, "limit is honoured after the merge");
  ok(idx.calls.length > 0 && idx.calls.every(([q, l]) => !/\s/.test(q)), "the index never sees a query containing whitespace");
  ok(idx.calls.some(([q, l]) => l >= PATHS.length), "per-piece scans ask for at least every indexed path so the intersection is not lossy");
}
{
  const h = loadHelper("1");
  const legacy = fakeIndex(PATHS, true);
  eq(h(legacy, "user service", 10).map(base).sort(), BOTH, "legacy index with readyCount: same set");
  ok(legacy.calls.every(([q, l]) => l === PATHS.length), "legacy index: per-piece scans ask for exactly readyCount");
  const empty = fakeIndex(PATHS, true);
  empty.readyCount = 0;
  eq(h(empty, "user service", 10), [], "legacy index still building (readyCount 0): nothing, as before");
}
// --- ORDER: the file the query names, not its directories ------------------------
// Measured live on 1.40609.0: the merge ordered by the SUMMED ORDINAL RANK of
// upstream's per-piece scans, and an ordinal sum is not a score - a short path
// that lands early in BOTH scans (a directory) beats the deep file the query
// describes. A multi-word query returned three sibling directories above the
// file it named. RANK_PATHS adds exactly that decoy: a path whose
// BASENAME (x.ts) matches neither piece, qualifying only because both pieces are
// subsequences of its DIRECTORIES. In this fake index it scores per-piece ranks
// 0 and 0, so rank-sum ordering placed it FIRST of the four; the label-first
// score places it last. The membership assertions above pin the SET; these pin
// the ORDER, which is all this ranking may change.
const RANK_PATHS = PATHS.concat(["src/user-service/types/x.ts"]);
const RANK_BOTH = BOTH.concat(["x.ts"]).sort();
{
  const h = loadHelper("1");
  const idx = fakeIndex(RANK_PATHS);
  const two = h(idx, "user service", 10).map(base);
  eq(two.slice(0, 2).sort(), ["user-service.spec.ts", "user.service.ts"],
     "ranking: the two files NAMED user*service take the first two places (rank-sum put the decoy first)");
  ok(two.indexOf("x.ts") > 1,
     "ranking: a path whose basename matches NEITHER piece cannot outrank them: " + JSON.stringify(two));
  eq(two.slice().sort(), RANK_BOTH, "ranking changes the ORDER only - the ANDed result set is unchanged");
  eq(h(idx, "user service spec", 10).map(base)[0], "user-service.spec.ts",
     "ranking: three pieces put the file whose NAME carries all three first");
  eq(h(idx, "User service", 10).map(base).sort(), [],
     "smart case is upstream's: an uppercase piece scans case-sensitively, so no all-lowercase path qualifies");
}
{
  const h = loadHelper("1");
  const idx = fakeIndex(PATHS);
  const out = h(idx, "readme", 5);
  eq(idx.calls, [["readme", 5]], "single piece: exactly one passthrough call with the caller's limit");
  eq(out.map(base), ["README.md"], "single piece result is upstream's own");
  idx.calls.length = 0;
  h(idx, "  readme  ", 5);
  eq(idx.calls, [["readme", 5]], "single piece with surrounding whitespace is trimmed (upstream would match a literal space)");
}
{
  const h = loadHelper("0");
  const idx = fakeIndex(PATHS);
  eq(h(idx, "user service", 10), [], "env var \"0\": upstream behaviour untouched (space is a literal char -> no hits)");
  eq(idx.calls, [["user service", 10]], "env var \"0\": the query is passed through verbatim");
  const h2 = loadHelper(undefined);
  const idx2 = fakeIndex(PATHS);
  h2(idx2, "user service", 10);
  eq(idx2.calls, [["user service", 10]], "env var unset: passthrough too (the feature is opt-in)");
}
{
  const h = loadHelper("1");
  const idx = fakeIndex(PATHS);
  eq(h(idx, "", 3).length, idx.search("", 3).length, "empty query is delegated unchanged (upstream serves its top-level cache)");
  // MAX_PIECES = 4 bounds the SCANS, not the pieces: "a b c d e f" scans the
  // first four verbatim and applies "e" and "f" as a filter over the result.
  // Asserting the CALLS (not just "<= 5 results", which an empty result would
  // also satisfy) is what proves the cap held rather than the query being dropped.
  idx.calls.length = 0;
  h(idx, "a b c d e f", 5);
  eq(idx.calls.length, 4, "more than four pieces still cost at most four scans");
  eq(idx.calls.map(([q]) => q), ["a", "b", "c", "d"], "the first four pieces are scanned verbatim, never concatenated");

  // REGRESSION: the pieces past the cap must stay an order-free AND. Folding
  // them into one piece re-imposed an order and silently returned nothing -
  // measured on the real worker for
  // modules/user/src/domain/user-run/factories/user.service.ts:
  // "...service factories" found nothing while "...factories service" matched.
  const orderIdx = fakeIndex(["modules/user/src/domain/user-run/factories/user.service.ts"]);
  const fwd = h(orderIdx, "modules user domain service factories", 10).map((r) => r.path);
  const rev = h(orderIdx, "modules user domain factories service", 10).map((r) => r.path);
  eq(fwd, rev, "5+ pieces are order-free: the same words match whatever order they are typed in");
  eq(fwd.length, 1, "and they do match the file that carries all five");

  // A whitespace-only query is the EMPTY query (upstream's top-level cache),
  // not a search for a literal space.
  const wsIdx = fakeIndex(["a/b.ts"]);
  wsIdx.calls.length = 0;
  h(wsIdx, "   ", 5);
  eq(wsIdx.calls.map(([q]) => q), [""], "a whitespace-only query is delegated as the empty query");
}

// --- Part B: the REAL worker, patched by the compiled Nim binary ---------------------
{
  const bin = join(ROOT, "patches/community/add_feature_files_quick_open_worker");
  // The unversioned extract (the fresh one /update works on) wins, else the newest
  // versioned one; a dir tagged STALE is never a candidate.
  const candidates = existsSync(join(ROOT, "tmp")) ? readdirSync(join(ROOT, "tmp"))
    .filter((d) => /^app\.asar\.contents(-\d+(\.\d+)*)?$/.test(d))
    .sort((a, b) => (a === "app.asar.contents") - (b === "app.asar.contents") ||
      a.localeCompare(b, undefined, { numeric: true }))
    .map((d) => join(ROOT, "tmp", d, ".vite/build/file-index-worker/fileIndexWorker.js"))
    .filter((p) => existsSync(p)) : [];
  let runnable = false;
  try { accessSync(bin, constants.X_OK); runnable = candidates.length > 0; } catch {}
  if (!runnable) {
    skip("real worker", existsSync(bin) ? "no extracted worker under tmp/app.asar.contents*/" : "patch binary not compiled (cd patches && make)");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "cdb-qopen-worker-"));
    const copy = join(dir, "fileIndexWorker.js");
    copyFileSync(candidates[candidates.length - 1], copy);
    const out = execFileSync(bin, [copy], { encoding: "utf8" });
    ok(/\[PASS\]|\[OK\]/.test(out) && !/\[FAIL\]/.test(out), "patch binary applies cleanly to the extracted worker: " + out.trim().split("\n").pop());
    execFileSync("node", ["--check", copy]);
    ok(true, "patched worker passes node --check");
    process.env.CDB_FILES_QUICK_OPEN = "1";
    const { FileIndexHost } = createRequire(import.meta.url)(copy);
    const host = new FileIndexHost();
    host.setEntries(PATHS.map((p) => ({ name: p.split("/").pop(), relativePath: p, fullPath: "/x/" + p, isDirectory: false })));
    const realTwo = host.search("user service", 10).map((r) => r.relativePath.split("/").pop());
    eq(realTwo.slice().sort(), BOTH, "REAL worker: 'user service' finds every path matching both pieces");
    // FileIndexHost.search preserves the helper's order (`for(...of __cdbQoSearch(...))`
    // pushing straight into its result array), so this is the ranking end to end.
    eq(realTwo.slice(0, 2).sort(), ["user-service.spec.ts", "user.service.ts"],
       "REAL worker: the two files NAMED user*service rank above the path that only matches 'user' across its directories");
    eq(host.search("user service spec", 10).map((r) => r.relativePath.split("/").pop()).sort(), SPEC,
       "REAL worker: 'user service spec' narrows to the paths matching all three pieces");
    process.env.CDB_FILES_QUICK_OPEN = "0";
    eq(host.search("user service", 10), [], "REAL worker: env \"0\" restores upstream's behaviour");
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
