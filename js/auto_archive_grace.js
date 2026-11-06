// Factory embedded in AutoArchiveEngine by
// patches/community/add_feature_auto_archive_grace.nim. Uses upstream's own
// five-minute sweep, never creates a timer or reads GitHub. State is
// profile-local and survives restart.
(function (engine, defaultEnabled) {
  const fs = require("node:fs"), path = require("node:path");
  const file = path.join(require("electron").app.getPath("userData"), "cdb-auto-archive-grace.json");
  const identity = session => JSON.stringify((session.prs || []).filter(p => !p.inherited)
    .map(p => [p.provider || "github", p.host || "github.com", p.repo, p.prNumber])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const enabled = session => (session.autoArchiveOnPrClose ?? defaultEnabled()) === true;
  const log = message => globalThis.__cdbDiag?.("[archive-grace] " + message);
  const terminal = state => state === "merged" || state === "closed";
  // Upstream's lookupPrState non-answers: an unreadable PR (null), no PR found
  // for the branch, or a close it could not confirm. None of them may cancel a
  // grace; only a positive non-terminal state (open) does.
  const positive = state => typeof state === "string" && state !== "no_pr_found" && state !== "unconfirmed_close";
  const validMinutes = m => Number.isInteger(m) && m >= 0 && m <= 10080;
  let records, current;
  const reopened = new Set();
  function readMinutes() {
    try { return globalThis.__cdbAutoArchiveMergeDelayMinutes?.() ?? 0; }
    catch (error) { log("cannot read the delay: " + String(error)); return NaN; }
  }
  // One settings read per sweep (begin() runs at sweep start).
  const minutes = () => current !== undefined ? current : readMinutes();
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
  function reconcile(sessions, delay) {
    load();
    const live = new Map(sessions.map(s => [s.sessionId, s]));
    for (const id of reopened) if (!live.has(id)) reopened.delete(id);
    const next = { ...records };
    let changed = false;
    for (const [id, entry] of Object.entries(next)) {
      const session = live.get(id);
      if (!session || session.isArchived || !enabled(session) || delay === 0 || entry.binding !== identity(session)) {
        delete next[id]; changed = true;
      }
    }
    // Start the clock even while a native safety hold (e.g. pinned/running)
    // keeps checkAndArchive from reaching the gate. No network reads here.
    if (validMinutes(delay) && delay > 0) {
      for (const session of sessions) {
        if (session.isArchived || !enabled(session) || reopened.has(session.sessionId)) continue;
        const own = engine.ownPrBindings(session.prs);
        if (!engine.terminalVerdict(session.sessionId, own, Date.now()).terminal) continue;
        if (!Object.hasOwn(next, session.sessionId)) {
          next[session.sessionId] = { binding: identity(session), since: Date.now() };
          changed = true;
          log(session.sessionId + ": terminal PR grace started (" + delay + " minutes)");
        }
      }
    }
    if (changed) commit(next);
  }
  const api = {
    // A read-only UI projection of the same ledger and sweep snapshot. It must
    // never start a clock, trigger a sweep, or claim a guaranteed archive time.
    async status(id) {
      // A fresh settings read, not the sweep snapshot: the display follows the
      // configured delay as soon as the renderer asks again.
      const delay = readMinutes();
      if (delay === 0) return { ok: true, active: false };
      if (!validMinutes(delay)) return { ok: false, error: "Invalid archive delay" };
      const session = await engine.sessionManager.getSession(id);
      if (!session || session.isArchived) return { ok: true, active: false };
      const isEnabled = enabled(session);
      if (!isEnabled) return { ok: true, active: true, enabled: false };
      const known = engine.terminalVerdict(id, engine.ownPrBindings(session.prs), Date.now()).terminal;
      if (!known || reopened.has(id)) return { ok: true, active: true, enabled: true, terminal: false };
      try {
        load();
        const entry = records[id];
        const deadline = entry?.binding === identity(session) ? entry.since + delay * 60000 : null;
        return { ok: true, active: true, enabled: true, terminal: true, deadline };
      } catch (error) {
        return { ok: false, error: "Archive deadline unavailable" };
      }
    },
    begin() { current = readMinutes(); },
    cancel(id) {
      // Do not recreate the clock from a stale CLOSED binding while the native
      // forge refresh is in flight; wait for a fresh terminal archive check.
      reopened.add(id);
      try {
        load();
        // Invalidate memory before persisting too: a failed cancellation write
        // must not let a re-close consume the previous deadline in this run.
        if (Object.hasOwn(records, id)) { delete records[id]; commit({ ...records }); }
      } catch (error) { log(id + ": cannot persist reopened-PR cancellation: " + String(error)); }
    },
    // Synchronous: is a recorded grace for this binding still running? Lets the
    // engine skip its PR lookup. Any doubt answers false, so the lookup and the
    // gate in wait() decide as usual.
    pending(session) {
      try {
        const delay = minutes();
        if (!validMinutes(delay) || delay === 0) return false;
        load();
        const entry = records[session.sessionId];
        return !!entry && !session.isArchived && enabled(session) && entry.binding === identity(session) &&
          Date.now() < entry.since + delay * 60000;
      } catch (error) { return false; }
    },
    async reconcileAll() {
      try {
        const delay = minutes();
        if (delay === 0) {
          // Immediate is upstream behavior: nothing to read or clean up unless
          // a ledger from an earlier nonzero delay is still on disk.
          try { load(); } catch (error) { return; }
          if (Object.keys(records).length === 0) { reopened.clear(); return; }
        }
        reconcile(await engine.sessionManager.getAllSessions(), delay);
      } catch (error) { log("cannot reconcile state: " + String(error)); }
    },
    async wait(session, state) {
      try {
        const delay = minutes();
        // Immediate must remain native behavior even if a leftover ledger is
        // unreadable. No deadline is required when the delay is disabled.
        if (delay === 0) {
          try { load(); forget(session.sessionId); } catch (error) { log("cannot clear disabled grace: " + String(error)); }
          return false;
        }
        load();
        if (!terminal(state)) {
          if (positive(state)) forget(session.sessionId);
          return false;
        }
        // Re-read after upstream's asynchronous lookups: an old binding must
        // never create or consume a deadline for a newly bound PR.
        const latest = await engine.sessionManager.getSession(session.sessionId);
        if (!latest || latest.isArchived || !enabled(latest) || identity(latest) !== identity(session)) {
          forget(session.sessionId); return true;
        }
        if (!validMinutes(delay)) throw new Error("invalid PR archive delay; expected 0..10080 minutes");
        reopened.delete(session.sessionId);
        const binding = identity(latest), now = Date.now();
        let entry = records[session.sessionId];
        if (!entry || entry.binding !== binding) {
          entry = { binding, since: now };
          commit({ ...records, [session.sessionId]: entry });
          log(session.sessionId + ": terminal PR grace started (" + delay + " minutes)");
        }
        // Clock rollback cannot make a grace period expire early.
        return now < entry.since + delay * 60000;
      } catch (error) {
        log(session.sessionId + ": holding PR archive; " + String(error));
        return terminal(state);
      }
    }
  };
  globalThis.__cdbArchiveGraceStatus = id => api.status(id);
  // "Keep this session" (1P page, cdb-archive-grace:keep): the setter upstream's
  // LocalSessions.setSessionAutoArchiveOnPrClose eIPC handler calls; it saves
  // the session and emits the update. The next reconcile drops the grace.
  globalThis.__cdbArchiveGraceKeep = async id => {
    const manager = engine.sessionManager;
    if (typeof manager?.setSessionAutoArchiveOnPrClose !== "function") return { ok: false, error: "no session setter" };
    const session = await manager.getSession(id);
    if (!session || session.isArchived) return { ok: false, error: "no such session" };
    manager.setSessionAutoArchiveOnPrClose(id, false);
    log(id + ": kept (Auto-archive on merge or close off for this session)");
    return { ok: true };
  };
  return api;
})
