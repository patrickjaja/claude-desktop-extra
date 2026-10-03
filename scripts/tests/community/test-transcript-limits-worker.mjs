#!/usr/bin/env node
/*
 * test-transcript-limits-worker.mjs - the worker-side helper of "Load large
 * sessions in full" (js/transcript_limits_worker.js, delivered into upstream's
 * .vite/build/heavy-work-worker/heavyWorkWorker.js by
 * patches/community/add_feature_transcript_limits_worker.nim).
 *
 * The helper wraps Anthropic's own limits object. The property that matters is
 * that it can never make the worker WORSE than stock: with the variable unset or
 * malformed it must hand back the very same object it was given. Exit 0 = PASS.
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

const SRC = readFileSync(join(ROOT, "js/transcript_limits_worker.js"), "utf8");
// The patch prepends the helper to a CommonJS bundle, where a top-level function
// declaration is simply in scope; reproduce that by running it in a context and
// pulling the function out.
function helper(env, hasProcess = true) {
  const sandbox = hasProcess ? { process: { env } } : {};
  vm.runInNewContext(SRC, vm.createContext(sandbox));
  return sandbox.__cdbTranscriptLimitsWorker;
}
const UPSTREAM = () => ({ mainBytes: 52428800, subagentBytes: 33554432, cachedEntryBytes: 104857600, cachedTotalBytes: 209715200 });

{
  const f = helper({});
  ok(typeof f === "function", "defines __cdbTranscriptLimitsWorker");
  const o = UPSTREAM();
  ok(f(o) === o, "variable UNSET: returns Anthropic's own object, the very same one (switch off = stock worker)");
}
{
  const f = helper({ CDB_TRANSCRIPT_LIMITS: "268435456,201326592,587202560,1174405120" });
  const r = f(UPSTREAM());
  ok(r.mainBytes === 268435456 && r.subagentBytes === 201326592 &&
     r.cachedEntryBytes === 587202560 && r.cachedTotalBytes === 1174405120,
     "four positive numbers: main, subagent, per-session cache, cache total, in that order");
}
for (const [label, val] of [
  ["only three numbers", "1,2,3"],
  ["five numbers", "1,2,3,4,5"],
  ["a non-number", "1,2,x,4"],
  ["a zero", "1,0,3,4"],
  ["a negative", "1,-2,3,4"],
  ["Infinity", "1,Infinity,3,4"],
  ["an empty string", ""],
  ["whitespace only", "   "]
]) {
  const f = helper({ CDB_TRANSCRIPT_LIMITS: val });
  const o = UPSTREAM();
  ok(f(o) === o, "malformed (" + label + "): falls back to Anthropic's own object untouched");
}
{
  const f = helper(null);
  const o = UPSTREAM();
  ok(f(o) === o, "no usable process.env: falls back untouched instead of throwing");
}
{
  const f = helper(null, false);
  const o = UPSTREAM();
  ok(f(o) === o, "no process global at all: falls back untouched instead of throwing");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
