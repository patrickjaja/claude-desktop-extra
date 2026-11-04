# Auto-fix ready-to-merge notices

On Linux, a PR selected by the existing Auto-fix sweep can wake its owning Code session when GitHub reports that it is ready to merge. Enable the app's existing **Auto-fix** switch for that bound PR; this patch adds no setting, timer, CLI poller or auto-merge action. It does not wake for PRs which are only bound but have Auto-fix off.

The `<ci-monitor-event>` is informational. It asks the session to report readiness and wait for the user's decision. It does **not** authorize merging, enabling auto-merge, deploying, or changing the repository. Any separately authorized action must revalidate HEAD and GitHub's current rules.

## Criteria

Two fresh GraphQL reads through the app's authenticated/rate-limited `GhRestClient.graphqlWithErrors` must agree on the PR's head and base commit IDs. Both must report:

- `state: OPEN`, `isDraft: false`, valid head/base SHA values;
- `mergeable: MERGEABLE` and `mergeStateStatus: CLEAN` (GitHub's merge-state aggregate, not merely an absence of textual conflicts);
- `reviewDecision: APPROVED`, or explicit `null` when GitHub reports no required-review decision;
- `isMergeQueueEnabled: false`: queue-enabled repositories are conservatively excluded rather than claiming direct-merge readiness;
- the last commit's OID equal to the PR head, with either an explicit null rollup (no checks) or a complete rollup whose state is `SUCCESS`, every CheckRun is `COMPLETED/SUCCESS` and every StatusContext is `SUCCESS`.

GitHub evaluates the branch protections/rules behind its merge-state and review-decision fields. This is a snapshot of GitHub's verdict, not an independent rules engine, proof that every possible merge method is allowed, or a guarantee that permissions/base/rules will remain unchanged. The message includes both observed SHAs.

`UNKNOWN`, missing fields, partial GraphQL errors, authentication/network/rate-limit failures, and pagination beyond the first 100 contexts never count as ready. `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`, draft/closed/merged PRs, outstanding reviews, pending/failed/cancelled/skipped/neutral checks do not notify. Requiring *all* listed checks to succeed is intentionally stricter than GitHub: optional skipped/neutral checks can suppress a notice even when GitHub permits merging. No requirement is inferred from an empty/missing list.

The sweep's original failure/conflict/comment handling is unchanged. Readiness is checked after that handling, using the same selected PR/session and `sendMessage` pipeline (`origin: auto-continuation`, `initiator: ci-monitor`). The CLI cap defers a wake to the next existing sweep. The persisted binding and in-memory PR entry are rechecked after network reads, so a detached, disabled or archived target cannot receive the notice.

## Delivery and persistence

`<userData>/autofix-merge-ready.json` is an atomic-replacement, mode-0600 delivery ledger, isolated automatically for named and third-party profiles. It contains host/repository/PR, head SHA and delivery metadata, not credentials or GitHub comment bodies. Diagnostics use `[merge-ready]` in `claude-patches.log`.

- Identity is normalized host + repository + PR. The head and observed ready/not-ready transition distinguish successive notices, even across session-owner changes.
- A new head, or a definite not-ready observation followed by readiness, rearms the notice. An unreadable/unknown observation does **not** rearm a previously delivered notice.
- Notification is never recorded before `sendMessage` returns `delivered: true`. Throws/drops remain retriable.
- Queued acceptance is pending until the existing `turnCompleted` callback. Repeated sweeps do not enqueue duplicates. `sendsDroppedUnsent` rearms the matching UUID, including a drop while `sendMessage` is still resolving.
- If readiness regresses or HEAD changes while a wake is still parked, the patch asks the existing queue to withdraw it. A turn already dispatched cannot be recalled; its message explicitly requires revalidation.
- A restart suppresses completed/directly accepted notices. A surviving parked UUID is retained across an engine restart; an unconfirmed queued notice no longer known to the queue retries after restart. This is **at-least-once**, not exactly-once: a crash after acceptance but before the ledger write/completion can produce another informational notice. The app's message store and this ledger do not share a transaction; marking delivered before acceptance to hide that window would lose events.
- A corrupt/unreadable ledger disables this helper for that process rather than erasing its history. A failed pre-send write prevents sending. Original upstream Auto-fix continues to work.

## Upstream anchors and validation

Audited against upstream **4.16336.0**, freshly extracted 2026-11-04. The implementation wraps `AutoFixEngine.checkSession`, preserving the original method, and prepends callbacks to `handleTurnCompleted` and `handleSendsDroppedUnsent`. All three anchors must match exactly once; the injected helper and all callback markers must be present for idempotency. No minified variable name is pinned; the harness exercises `$` identifiers and rejects missing/duplicate/partial anchors.

Runtime dependencies to re-audit after upstream changes: `engine.diffState`, `sessionManager.githubPr.config.getSession`, `githubPr.ghRest.graphqlWithErrors`, `hasLiveQuery`, `cliGovernor.isAtCap`, `isSendParked`, `withdrawParkedSend`, and `sendMessage`'s `delivered/queued` receipt plus completion/drop events. The feature harness covers helper state transitions and compiled injection wiring; it does not prove live Electron delivery.

## Activation

This change needs a newly built package containing this patch and a subsequent app restart. No install/restart is part of development validation. In the current local environment, coordinate that separately with the Auto-fix trusted-author work in [patrickjaja/claude-desktop-extra#308](https://github.com/patrickjaja/claude-desktop-extra/pull/308): do not replace the installed trusted-author build with a package from this branch alone. The activation build must contain both independently reviewed changes and preserve the exact installed trusted-author configuration; then, with explicit approval, install that combined build, restart, enable Auto-fix on a test PR and verify a single informational event after a pending-to-ready transition. Do not enable auto-merge for the test.
