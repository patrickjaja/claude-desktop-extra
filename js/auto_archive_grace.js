// Factory embedded in AutoArchiveEngine. Uses its existing five-minute sweep,
// never creates a timer or reads GitHub. State is profile-local and survives restart.
(function (engine, defaultEnabled) {
  const fs = require("node:fs"), path = require("node:path");
  const file = path.join(require("electron").app.getPath("userData"), "cdb-auto-archive-grace.json");
  const identity = session => JSON.stringify((session.prs || []).filter(p => !p.inherited)
    .map(p => [p.provider || "github", p.host || "github.com", p.repo, p.prNumber])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const enabled = session => (session.autoArchiveOnPrClose ?? defaultEnabled()) === true;
  const log = message => globalThis.__cdbDiag?.("[archive-grace] " + message);
  let records;
  function load() {
    if (records) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || data.version !== 1 || !data.records || typeof data.records !== "object" || Array.isArray(data.records))
        throw new Error("invalid grace state schema");
      for (const entry of Object.values(data.records)) {
        if (!entry || typeof entry.binding !== "string" || !Number.isSafeInteger(entry.since) || entry.since < 0)
          throw new Error("invalid grace deadline");
      }
      records = data.records;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      records = {};
    }
  }
  function commit(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({ version: 1, records: next }), { mode: 0o600 });
    fs.renameSync(temp, file);
    records = next;
  }
  function forget(id) {
    if (!Object.hasOwn(records, id)) return;
    const next = { ...records }; delete next[id]; commit(next);
  }
  function reconcile(sessions) {
    load();
    const live = new Map(sessions.map(s => [s.sessionId, s]));
    const next = { ...records };
    const minutes = globalThis.__cdbAutoArchiveMergeDelayMinutes?.() ?? 0;
    let changed = false;
    for (const [id, entry] of Object.entries(next)) {
      const session = live.get(id);
      if (!session || session.isArchived || !enabled(session) || minutes === 0 || entry.binding !== identity(session)) {
        delete next[id]; changed = true;
      }
    }
    // Start the clock even while a native safety hold (e.g. pinned/running)
    // prevents checkAndArchive from being called. No network reads here.
    if (Number.isInteger(minutes) && minutes > 0 && minutes <= 10080) {
      for (const session of sessions) {
        if (session.isArchived || !enabled(session)) continue;
        const own = engine.ownPrBindings(session.prs);
        if (!engine.terminalVerdict(session.sessionId, own, Date.now()).terminal) continue;
        if (!Object.hasOwn(next, session.sessionId)) {
          next[session.sessionId] = { binding: identity(session), since: Date.now() };
          changed = true;
          log(session.sessionId + ": terminal PR grace started (" + minutes + " minutes)");
        }
      }
    }
    if (changed) commit(next);
  }
  return {
    cancel(id) {
      try {
        load();
        // Invalidate memory before persisting too: a failed cancellation write
        // must not let a re-close consume the previous deadline in this run.
        if (Object.hasOwn(records, id)) { delete records[id]; commit({ ...records }); }
      } catch (error) { log(id + ": cannot persist reopened-PR cancellation: " + String(error)); }
    },
    async reconcileAll() {
      try { reconcile(await engine.sessionManager.getAllSessions()); }
      catch (error) { log("cannot reconcile state: " + String(error)); }
    },
    async wait(session, state) {
      try {
        const minutes = globalThis.__cdbAutoArchiveMergeDelayMinutes?.() ?? 0;
        // Immediate must remain native behavior even if a leftover ledger is
        // unreadable. No deadline is required when the delay is disabled.
        if (minutes === 0) {
          try { load(); forget(session.sessionId); } catch (error) { log("cannot clear disabled grace: " + String(error)); }
          return false;
        }
        load();
        // Re-read after upstream's asynchronous lookups: an old binding must
        // never create or consume a deadline for a newly bound PR.
        const latest = await engine.sessionManager.getSession(session.sessionId);
        if (!latest || latest.isArchived || !enabled(latest) || identity(latest) !== identity(session)) {
          forget(session.sessionId); return true;
        }
        if (state !== "merged" && state !== "closed") { forget(session.sessionId); return false; }
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080)
          throw new Error("invalid PR archive delay; expected 0..10080 minutes");
        const binding = identity(latest), now = Date.now();
        let entry = records[session.sessionId];
        if (!entry || entry.binding !== binding) {
          entry = { binding, since: now };
          commit({ ...records, [session.sessionId]: entry });
          log(session.sessionId + ": terminal PR grace started (" + minutes + " minutes)");
        }
        // Clock rollback cannot make a grace period expire early.
        return now < entry.since + minutes * 60000;
      } catch (error) {
        log(session.sessionId + ": holding PR archive;" + String(error));
        return state === "merged" || state === "closed";
      }
    }
  };
})
