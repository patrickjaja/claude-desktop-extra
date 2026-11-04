// Embedded as an expression in AutoFixEngine; no timer or separate poller.
// Cost: one GraphQL read per sweep per Auto-fix PR (none while the app's own
// GraphQL budget guard says low or a rate-limit window is open, none while a
// failed send backs off); a PR already notified at its head is re-read at most
// every 10 minutes, only to notice a new head or a regression.
(function __cdbCreateMergeReady(engine, dependencies) {
  const manager = engine.sessionManager;
  const fs = dependencies?.fs || require("node:fs");
  const path = dependencies?.path || require("node:path");
  const uuid = dependencies?.uuid || require("node:crypto").randomUUID;
  const now = dependencies?.now || Date.now;
  const NOTIFIED_REREAD_MS = 10 * 60 * 1000;
  const file = path.join(dependencies?.userData || require("electron").app.getPath("userData"), "autofix-merge-ready.json");
  const log = error => (globalThis.__cdbDiag || (() => {}))(`[merge-ready] ${String(error)}`);
  const query = `query CdbMergeReady($owner:String!,$name:String!,$number:Int!) {
    repository(owner:$owner,name:$name) { pullRequest(number:$number) {
      state isDraft headRefOid baseRefOid mergeable mergeStateStatus reviewDecision isMergeQueueEnabled
      commits(last:1) { nodes { commit { oid statusCheckRollup {
        state contexts(first:100) { pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun { status conclusion isRequired(pullRequestNumber:$number) }
          ... on StatusContext { state }
        } }
      } } } }
    } }
  }`;
  let states = Object.create(null), usable = true;
  const inFlight = new Set(), livePending = new Set(), awaitingReceipt = new Map();
  // In memory only: the last ready observation per key (a notice needs two
  // consecutive sweeps agreeing on head and base), when a key was last read,
  // and the send-failure backoff (like upstream's sendFailureCounts).
  const observed = new Map(), lastReadAt = new Map(), backoff = new Map();
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    if (stored.version !== 1 || !stored.states || typeof stored.states !== "object" || Array.isArray(stored.states)) throw Error("invalid readiness ledger");
    states = Object.assign(Object.create(null), stored.states);
  } catch (error) {
    if (error.code !== "ENOENT") { usable = false; log(error); }
  }
  const serialize = () => JSON.stringify({ version: 1, states });
  let saved = serialize();
  // Writes only when the ledger changed since the last successful write.
  function save() {
    const text = serialize();
    if (text === saved) return;
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, file);
    saved = text;
  }
  // Upstream's own guard (GitHubPrManager.readBudgets + graphqlBudgetLow, the
  // check its row refresh uses). Missing methods mean no read: fail closed.
  function budgetAllows(host) {
    try {
      const github = manager.githubPr;
      if (typeof github?.readBudgets !== "function" || typeof github.graphqlBudgetLow !== "function") return false;
      const graphql = github.readBudgets(host)?.graphql;
      if (!graphql || graphql.rateLimited !== false) return false;
      return github.graphqlBudgetLow(host, graphql.remaining) === false;
    } catch (error) { log(error); return false; }
  }
  function sendFailed(key) {
    const count = (backoff.get(key)?.count ?? 0) + 1;
    backoff.set(key, { count, skip: Math.min(2 ** count, 16) - 1 });
  }
  function verdict(pr) {
    const sha = /^[0-9a-f]{40}$/;
    if (!pr || !sha.test(pr.headRefOid || "") || !sha.test(pr.baseRefOid || "")) return "unknown";
    if (["CLOSED", "MERGED"].includes(pr.state) || pr.isDraft === true) return "blocked";
    if (pr.state !== "OPEN" || pr.isDraft !== false) return "unknown";
    if (["BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "DRAFT"].includes(pr.mergeStateStatus) || pr.mergeable === "CONFLICTING") return "blocked";
    // CLEAN is GitHub's aggregate branch-protection/rules verdict, not just
    // mergeable=true. Queue-required repositories need a different action.
    if (pr.mergeStateStatus !== "CLEAN" || pr.mergeable !== "MERGEABLE") return "unknown";
    if (pr.isMergeQueueEnabled === true || ["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(pr.reviewDecision)) return "blocked";
    if (pr.isMergeQueueEnabled !== false || !(pr.reviewDecision === null || pr.reviewDecision === "APPROVED")) return "unknown";
    const commits = pr.commits?.nodes;
    if (!Array.isArray(commits) || commits.length !== 1 || commits[0]?.commit?.oid !== pr.headRefOid) return "unknown";
    const rollup = commits[0].commit.statusCheckRollup;
    if (rollup === null) return "ready"; // Explicitly no checks, not a missing field.
    const contexts = rollup?.contexts;
    if (!contexts || contexts.pageInfo?.hasNextPage !== false || !Array.isArray(contexts.nodes) || contexts.nodes.length === 0) return "unknown";
    for (const check of contexts.nodes) {
      if (check?.__typename === "CheckRun") {
        if (["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"].includes(check.status)) return "blocked";
        if (check.status !== "COMPLETED") return "unknown";
        if (check.conclusion === "SKIPPED") {
          if (check.isRequired === false) continue;
          return check.isRequired === true ? "blocked" : "unknown";
        }
        if (["FAILURE", "CANCELLED", "NEUTRAL", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"].includes(check.conclusion)) return "blocked";
        if (check.conclusion !== "SUCCESS") return "unknown";
      } else if (check?.__typename === "StatusContext") {
        if (["PENDING", "ERROR", "FAILURE", "EXPECTED"].includes(check.state)) return "blocked";
        if (check.state !== "SUCCESS") return "unknown";
      } else return "unknown";
    }
    return rollup.state === "SUCCESS" ? "ready" : ["PENDING", "FAILURE", "ERROR", "EXPECTED"].includes(rollup.state) ? "blocked" : "unknown";
  }
  async function read(pr) {
    const [owner, name] = pr.repo.split("/");
    try {
      const response = await manager.githubPr.ghRest.graphqlWithErrors(query, { owner, name, number: pr.prNumber }, pr.host || "github.com", "merge_ready");
      if (!Array.isArray(response?.errors) || response.errors.length !== 0) return;
      return response.data?.repository?.pullRequest;
    } catch (error) { log(error); }
  }
  // outcome: "completed", "dropped" (retriable) or "cancelled" (the user
  // deleted the queued notice or pressed Stop: dismissed, never re-sent for
  // this head - upstream ignores a cancelled drop the same way).
  function acknowledge(sessionId, messageId, outcome) {
    if (!usable) return;
    if (awaitingReceipt.has(messageId)) {
      awaitingReceipt.set(messageId, outcome);
      return;
    }
    for (const state of Object.values(states)) {
      if (state.sessionId !== sessionId || state.messageId !== messageId) continue;
      livePending.delete(messageId);
      state.pending = false;
      state.notified = outcome !== "dropped";
      state.delivery = outcome;
      try { save(); } catch (error) { usable = false; log(error); }
    }
  }
  return {
    verdict,
    completed(sessionId, messageId) { acknowledge(sessionId, messageId, "completed"); },
    dropped(sessionId, messageIds, reason) {
      for (const id of messageIds || []) acknowledge(sessionId, id, reason === "cancelled" ? "cancelled" : "dropped");
    },
    async check(session, pr) {
      if (!usable || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pr.repo || "") || !Number.isSafeInteger(pr.prNumber) || pr.prNumber <= 0) return;
      const host = (pr.host || "github.com").toLowerCase();
      if (!/^[a-z0-9.-]+$/.test(host)) return;
      const key = `${host}/${pr.repo.toLowerCase()}#${pr.prNumber}`;
      if (inFlight.has(key)) return;
      const sessionId = session.sessionId;
      const entries = engine.diffState.get(sessionId);
      const upstreamKey = `${host === "github.com" ? "" : host + "\n"}${pr.repo.toLowerCase()}#${pr.prNumber}`;
      const entry = entries?.get(upstreamKey);
      const active = () => {
        if (!entry || engine.diffState.get(sessionId) !== entries || entries.get(upstreamKey) !== entry || entry.closed) return false;
        const latest = manager.githubPr.config.getSession(sessionId);
        return !!latest && !latest.isArchived && latest.prs?.some(binding =>
          binding.prNumber === pr.prNumber && binding.repo?.toLowerCase() === pr.repo.toLowerCase() &&
          (binding.host || "github.com").toLowerCase() === host && binding.autoFix && !binding.inherited &&
          !binding.dismissed && binding.unconfirmed === undefined &&
          [undefined, "github", "github-enterprise"].includes(binding.provider) &&
          ["OPEN", "QUEUED"].includes(binding.state?.toUpperCase()));
      };
      if (!active() && !entry?.closed) return;
      inFlight.add(key);
      try {
        // The original checkSession has already positively read CLOSED/MERGED.
        // Preserve that observed transition if the same head is later reopened.
        if (entry?.closed) {
          const previous = states[key];
          if (previous?.pending && manager.isSendParked(previous.sessionId, previous.messageId)) await manager.withdrawParkedSend(previous.sessionId, previous.messageId);
          if (previous?.messageId) livePending.delete(previous.messageId);
          observed.delete(key);
          delete states[key];
          save();
          return;
        }
        // A failed send backs off: skip 1, 3, 7, then 15 sweeps.
        const wait = backoff.get(key);
        if (wait?.skip > 0) { wait.skip--; return; }
        // Already notified at its head: re-read only every 10 minutes, to see
        // a new head or a regression. A new head waiting for its confirming
        // read is not throttled.
        const known = states[key];
        if (known?.ready && known.notified && !known.pending && (observed.get(key)?.head ?? known.head) === known.head &&
          lastReadAt.has(key) && now() - lastReadAt.get(key) < NOTIFIED_REREAD_MS) return;
        if (!budgetAllows(host)) return;
        lastReadAt.set(key, now());
        const current = await read(pr);
        if (!active()) return;
        const result = verdict(current);
        if (result === "unknown") { observed.delete(key); return; }
        // Ready counts only when the previous read of this key was ready at the
        // same head and base; any other verdict restarts the confirmation.
        const seen = observed.get(key);
        const confirmed = result === "ready" && !!seen && seen.head === current.headRefOid && seen.base === current.baseRefOid;
        if (result === "ready") observed.set(key, { head: current.headRefOid, base: current.baseRefOid });
        else observed.delete(key);
        let previous = states[key];
        if (previous?.pending && previous.head !== current.headRefOid && manager.isSendParked(previous.sessionId, previous.messageId)) {
          await manager.withdrawParkedSend(previous.sessionId, previous.messageId);
          if (!active()) return;
        }
        if (!previous || previous.head !== current.headRefOid) {
          if (previous?.messageId) livePending.delete(previous.messageId);
          previous = { head: current.headRefOid, ready: false, notified: false, pending: false };
        }
        if (result !== "ready") {
          if (previous.pending && manager.isSendParked(previous.sessionId, previous.messageId)) await manager.withdrawParkedSend(previous.sessionId, previous.messageId);
          livePending.delete(previous.messageId);
          backoff.delete(key);
          states[key] = { head: current.headRefOid, ready: false, notified: false, pending: false };
          save();
          return;
        }
        // Surviving parked sends retain their UUID across engine restarts.
        // If the queue no longer knows an unconfirmed UUID, retry at-least-once.
        if (previous.pending && !livePending.has(previous.messageId) && !manager.isSendParked(previous.sessionId, previous.messageId)) {
          previous.pending = false;
          previous.notified = false;
        }
        if (previous.ready && (previous.notified || previous.pending)) return;
        if (!confirmed) return;
        if (!manager.hasLiveQuery(sessionId) && manager.cliGovernor.isAtCap()) return;
        const messageId = uuid();
        states[key] = { ...previous, ready: true, notified: false, pending: false, sessionId, messageId, delivery: "sending" };
        save(); // If persistence is unavailable, do not send an untracked wake.
        const text = `<ci-monitor-event>\nThe desktop app read GitHub twice: https://${host}/${pr.repo}/pull/${pr.prNumber} is ready to merge at HEAD ${current.headRefOid} (base ${current.baseRefOid}): open, not draft, CLEAN/MERGEABLE, required checks successful, optional skipped checks confirmed non-required, and review requirements satisfied. This is an informational readiness notice only. It does not authorize merge, auto-merge, deployment, or any repository change. Report readiness to the user and wait for their decision. Revalidate the current HEAD and GitHub rules before any separately authorized action; GitHub may have changed since this observation. Do not start a CI poller.\n</ci-monitor-event>`;
        awaitingReceipt.set(messageId, undefined);
        let sent;
        try {
          sent = await manager.sendMessage(sessionId, text, undefined, { origin: { kind: "auto-continuation" }, initiator: "ci-monitor", messageUuid: messageId });
        } catch (error) { awaitingReceipt.delete(messageId); sendFailed(key); throw error; }
        const earlyOutcome = awaitingReceipt.get(messageId);
        awaitingReceipt.delete(messageId);
        if (sent?.delivered !== true) { sendFailed(key); return; }
        backoff.delete(key);
        // A completion/drop callback may arrive before the receipt. Bank it,
        // but do not mark notified until acceptance is positively confirmed.
        if (states[key]?.messageId !== messageId) return;
        if (earlyOutcome === "dropped") { states[key].delivery = "dropped"; save(); return; }
        if (earlyOutcome === "completed" || earlyOutcome === "cancelled") { states[key].notified = true; states[key].delivery = earlyOutcome; }
        if (!states[key].notified) {
          states[key].pending = sent.queued === true;
          if (states[key].pending) livePending.add(messageId);
          states[key].notified = sent.queued !== true;
        }
        save();
      } catch (error) { log(error); }
      finally { inFlight.delete(key); }
    }
  };
})
