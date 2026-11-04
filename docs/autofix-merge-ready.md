# Auto-fix ready-to-merge notices

On Linux, a PR watched by the app's existing **Auto-fix** sweep can wake its owning Code session when GitHub reports that it is ready to merge.

## Turning it on

Settings -> Extra -> Community Features -> **Wake Auto-fix sessions when a PR is ready to merge**. Off by default; the switch applies live (the next Auto-fix sweep reads it, no restart). The setting is the `autoFixMergeReady` key in `<userData>/claude-desktop-extra.json`; a boolean for the same key in the hand-owned `claude-desktop-extra.jsonc` wins and locks the switch.

The notice is only sent for PRs whose own **Auto-fix** switch is on; PRs that are only bound to a session are left alone. The patch adds no timer, CLI poller or auto-merge action.

The `<ci-monitor-event>` is informational. It asks the session to report readiness and wait for the user's decision. It does **not** authorize merging, enabling auto-merge, deploying, or changing the repository. Any separately authorized action must revalidate HEAD and GitHub's current rules.

## Criteria

Two GraphQL reads through the app's authenticated, rate-limited `GhRestClient.graphqlWithErrors`, on two consecutive Auto-fix sweeps, must agree on the PR's head and base commit IDs. Both must report:

- `state: OPEN`, `isDraft: false`, valid head/base SHA values;
- `mergeable: MERGEABLE` and `mergeStateStatus: CLEAN` (GitHub's merge-state aggregate, not merely an absence of textual conflicts);
- `reviewDecision: APPROVED`, or explicit `null` when GitHub reports no required-review decision;
- `isMergeQueueEnabled: false`: queue-enabled repositories are conservatively excluded rather than claiming direct-merge readiness;
- the last commit's OID equal to the PR head, with either an explicit null rollup (no checks) or a complete rollup whose state is `SUCCESS`, every CheckRun is `COMPLETED/SUCCESS` and every StatusContext is `SUCCESS`.

GitHub evaluates the branch protections/rules behind its merge-state and review-decision fields. This is a snapshot of GitHub's verdict, not an independent rules engine, proof that every possible merge method is allowed, or a guarantee that permissions/base/rules will remain unchanged. The message includes both observed SHAs.

`UNKNOWN`, missing fields, partial GraphQL errors, authentication/network/rate-limit failures, and pagination beyond the first 100 contexts never count as ready, and any of them between the two reads restarts the confirmation. `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`, draft/closed/merged PRs, outstanding reviews, pending/failed/cancelled/skipped/neutral checks do not notify. Requiring *all* listed checks to succeed is intentionally stricter than GitHub: optional skipped/neutral checks can suppress a notice even when GitHub permits merging. No requirement is inferred from an empty/missing list.

The sweep's original failure/conflict/comment handling is unchanged and runs first. Readiness is checked after it, inside its own try/catch, so nothing the readiness check throws can reach the sweep or skip upstream's own wakes for the other PRs. It uses the same selected PR/session and `sendMessage` pipeline (`origin: auto-continuation`, `initiator: ci-monitor`). The CLI cap defers a wake to the next sweep. The persisted binding and in-memory PR entry are rechecked after network reads, so a detached, disabled or archived target cannot receive the notice.

## Cost

Auto-fix sweeps every 60 seconds while the app is focused and every 5 minutes otherwise.

- **One GitHub GraphQL read per sweep per Auto-fix PR.** Readiness is confirmed by the next sweep's read, not by an immediate second read.
- **A notified PR is re-read at most every 10 minutes**, only to notice a new head or a regression. A new head seen by that read gets its confirming read on the next sweep.
- **No read while the app's own budget guard says no**: when GitHub reports the GraphQL budget for that host as low, or a rate-limit window is open (the same `readBudgets` / `graphqlBudgetLow` check the app's PR row refresh uses). If that guard is missing in a future build, the read is skipped.
- **A send that is not delivered backs off** like Auto-fix's own wakes: the next attempt waits 1, 3, 7, then 15 sweeps.
- **One model turn per notice.** The ledger file is only rewritten when its content changes.

## Delivery and persistence

`<userData>/autofix-merge-ready.json` is an atomic-replacement, mode-0600 delivery ledger, isolated automatically for named and third-party profiles. It contains host/repository/PR, head SHA and delivery metadata, not credentials or GitHub comment bodies. Diagnostics use `[merge-ready]` in `claude-patches.log`.

- Identity is normalized host + repository + PR. The head and observed ready/not-ready transition distinguish successive notices, even across session-owner changes.
- A new head, or a definite not-ready observation followed by readiness, rearms the notice. An unreadable/unknown observation does **not** rearm a previously delivered notice.
- Notification is never recorded before `sendMessage` returns `delivered: true`. Throws and undelivered sends stay retriable (with the backoff above).
- Queued acceptance is pending until the existing `turnCompleted` callback. Repeated sweeps do not enqueue duplicates. A `sendsDroppedUnsent` for the matching UUID rearms the notice, including a drop while `sendMessage` is still resolving - except a drop with reason `cancelled` (the user deleted the queued notice or pressed Stop), which counts as dismissed: that head is not notified again.
- If readiness regresses or HEAD changes while a wake is still parked, the patch asks the existing queue to withdraw it. A turn already dispatched cannot be recalled; its message explicitly requires revalidation.
- A restart suppresses completed/directly accepted/dismissed notices. A surviving parked UUID is retained across an engine restart; an unconfirmed queued notice no longer known to the queue retries after restart. This is **at-least-once**, not exactly-once: a crash after acceptance but before the ledger write/completion can produce another informational notice. The app's message store and this ledger do not share a transaction; marking delivered before acceptance to hide that window would lose events.
- A corrupt/unreadable ledger disables this helper for that process rather than erasing its history. A failed pre-send write prevents sending. Original upstream Auto-fix continues to work.

## Upstream anchors and validation

Audited against upstream **4.16336.0**. The patch wraps `AutoFixEngine.checkSession`, preserving the original method and its result, and prepends contained callbacks to `handleTurnCompleted` and `handleSendsDroppedUnsent` (the latter passes the drop reason through). All three anchors must match exactly once; idempotency checks the exact injected end states (switch gate, try/catch, helper). No minified variable name is pinned; the harness exercises `$` identifiers and rejects missing/duplicate/partial/older-shape injections.

Runtime dependencies to re-audit after upstream changes: `engine.diffState`, `sessionManager.githubPr.config.getSession`, `githubPr.ghRest.graphqlWithErrors`, `githubPr.readBudgets` / `githubPr.graphqlBudgetLow`, `hasLiveQuery`, `cliGovernor.isAtCap`, `isSendParked`, `withdrawParkedSend`, and `sendMessage`'s `delivered/queued` receipt plus the completion/drop events and the drop reason `cancelled`. The feature harness (`scripts/tests/community/test-autofix-merge-ready.mjs`) covers helper state transitions, the cost rules, the compiled wrapper and the settings switch; it does not prove live Electron delivery.
