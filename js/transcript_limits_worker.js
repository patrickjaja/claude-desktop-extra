/*
 * transcript_limits_worker.js - worker half of "Load large sessions in full".
 *
 * The heavy-work utility process bundles its own copy of Anthropic's session
 * manager, with its own limits object literal. patches/community/
 * add_feature_transcript_limits_worker.nim prepends this helper and wraps that
 * literal in it:
 *
 *     {mainBytes:..,subagentBytes:..,cachedEntryBytes:..,cachedTotalBytes:..}
 *  -> __cdbTranscriptLimitsWorker({mainBytes:..,subagentBytes:..,...})
 *
 * The main process decides (js/transcript_limits_main.js) and hands the numbers
 * over as process.env.CDB_TRANSCRIPT_LIMITS = "main,subagent,entry,total" (bytes)
 * before the worker is forked. Unset, malformed or not four positive numbers
 * -> Anthropic's own object comes back untouched, so a bad value can never make
 * the worker worse than stock.
 */
function __cdbTranscriptLimitsWorker(orig) {
  try {
    var v = typeof process !== "undefined" && process.env && process.env.CDB_TRANSCRIPT_LIMITS;
    if (!v) return orig;
    var p = String(v).split(",").map(Number);
    if (p.length !== 4 || !p.every(function (n) { return isFinite(n) && n > 0; })) return orig;
    return { mainBytes: p[0], subagentBytes: p[1], cachedEntryBytes: p[2], cachedTotalBytes: p[3] };
  } catch (e) {
    return orig;
  }
}
