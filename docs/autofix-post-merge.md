# Auto-fix comments after merge

On Linux, Auto-fix can forward new comments on a **merged** GitHub PR to its owning Code session as quoted informational notices. Upstream's Auto-fix sweep stops reading a PR once it is merged, so feedback that lands after the merge (a late review, a bot's post-merge report) is otherwise never seen by the session. The patch runs from `AutoFixEngine.sweep` and the existing `ci-monitor` send queue; it adds no timer, cron job or parallel poller.

## Turning it on

Settings -> Extra -> Community Features -> **Auto-fix notices: ready to merge, comments after merge**. The switch is shared with [ready-to-merge notices](autofix-merge-ready.md): one key, `autoFixMergeReady` in `<userData>/claude-desktop-extra.json`, turns on both. Off by default; it applies live, because the sweep wrapper asks `globalThis.__cdbAutoFixMergeReadyEnabled()` on every sweep. A boolean for the same key in the hand-owned `claude-desktop-extra.jsonc` wins and locks the switch. With the switch off, upstream's sweep runs unchanged and the patch makes no GitHub read and touches no file.

Only PRs whose own **Auto-fix** switch is on are followed.

## Information is not authorization

Post-merge notices are separate from the ordinary Auto-fix fix-and-push prompt. They identify the PR and quote feedback, but expressly grant **no authorization** to change code, commit, push, reply on GitHub, open another PR, merge or deploy. The agent reports the feedback and awaits separate user authorization for any action.

## What is forwarded

Issue comments, inline review comments and review summaries, with the same trust filter upstream uses for the CI comments Auto-fix forwards on an open PR:

- **Authors:** only comments whose author is a GitHub bot (`user.type === "Bot"`) or whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. `CONTRIBUTOR`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, `NONE` and a missing association are dropped. The authenticated GitHub user's own comments are dropped too.
- **Reviews:** only states `CHANGES_REQUESTED` and `COMMENTED` with a non-empty body; approvals, dismissed and pending reviews are dropped.
- **Resolved inline threads are still forwarded.** GitHub's REST review-comment payload does not say whether a thread is resolved (only GraphQL does), and the patch adds no GraphQL scan, so inline comments are kept regardless of resolution.
- **Time:** review summaries use `submitted_at`, other comments `created_at`. Only timestamps strictly after GitHub's `merged_at`, within the 7-day window below and at or after the feature's first activation for the account are eligible. Old history is not replayed when the switch is first turned on; comments that arrive while the app is stopped are picked up on the next sweep. Editing an existing comment is not a new comment.

Text hygiene: each author and body is NFC-normalized, control and format characters are removed, `@` becomes the fullwidth `＠` (U+FF20, as upstream's own text normalizer does, so a quoted mention cannot notify anyone), the text is capped at 1200 code points (never splitting a surrogate pair) with `…` appended when cut, opening angle brackets are escaped and every line is quoted with `> `. At most 20 comments go into one notice; later sweeps drain the rest.

## The 7-day window

A merged PR is read for at most **7 days after its `merged_at`**. Past that, the patch drops the PR's ledger entry and keeps only its key in the ledger's `expired` list, so it is never read again while a binding still names it; the key is removed once no Auto-fix binding refers to the PR. A PR first seen more than 7 days after its merge is read once, forwards nothing, and is marked expired.

## Cost

Auto-fix sweeps every 60 seconds while the app is focused and every 5 minutes otherwise.

- **One round of GitHub REST reads per Auto-fix PR per sweep** while it is inside its window: the PR itself plus its three comment lists (issue comments, review comments, reviews), all ETag-conditional, so an unchanged list costs a `304`.
- **No read while the REST budget is low:** the read is skipped when GitHub reports fewer than **1000** remaining REST requests for that host, or a rate-limit window is open. 1000 is upstream's own REST low-budget threshold (`rest:1e3` in 4.16336.0).
- **Failures back off** per PR, doubling from 1 minute up to 30 minutes. At most five PRs are read at once, the same batch size as the engine's own sweep.
- **One model turn per notice.**

## Archived sessions and ownership

**Archived sessions are not read and do not wake.** No session is unarchived and no autoarchive preference is changed; an unarchived session can receive comments that are still inside the window.

Inherited, dismissed, unconfirmed, disabled or non-GitHub bindings are excluded, as are sessions stopped until a person sends. Duplicate bindings get a single owner (the existing owner, otherwise the earliest session, stable ID tie-break); an archived owner's binding does not move to an active duplicate unless the old binding is removed or disabled. Closed-without-merge and open PRs are left to upstream.

## Persistence and failure handling

`autofix-post-merge.json` is an atomic, mode-0600 ledger in the app's **account/org storage directory**, itself scoped by the profile's userData. Keys are host + repository + PR number, not the head SHA, so a new head cannot replay comments. It holds seen comment IDs, the pending batch with its message UUID, the PR's `merged_at`, and the expired keys; no comment bodies or credentials. Switching accounts cannot send an in-flight notice into the new account.

A queued notice counts as seen only after its turn completes, or when the user deletes or stops it (dismissed). A lost send is retried with its original UUID; a send still parked in the queue is not duplicated. Delivery is **at least once**: a crash between acceptance and the ledger write can repeat a notice. A failed or undelivered send never consumes comment IDs. Missing authentication, unknown hosts, incomplete pagination and a corrupt or unwritable ledger fail closed, and a failed pre-send write prevents the send. Diagnostics use `[post-merge]` in `claude-patches.log`, without comment bodies or credentials.

When the CLI processes multiple queued messages in one turn, upstream 4.16336.0 emits completion only for the first message UUID. With the switch on, sub-patch D of `add_feature_autofix_merge_ready.nim` extends that healthy-turn event to the batch's additional `pendingCycle.promptUuids`, only if they have been echoed (not in `pendingEchoUuids`), remain buffered user messages, are not withdrawn and are not reserved as `nextCycleUuid`. IDs are deduplicated. Unhealthy, adopted, stale-query and subagent results remain excluded by upstream's original guards. With the switch off, and on other platforms, upstream's single completion event is unchanged. This avoids leaving a delivered notice pending just because another message headed its batch; it does not create an exactly-once guarantee across crashes.

## Upstream anchors and validation

Audited against upstream **4.16336.0**. The patch wraps `AutoFixEngine.sweep` (the original always runs first, then the gated helper inside a try/catch) and prepends contained callbacks to `handleTurnCompleted` and `handleSendsDroppedUnsent`. Each anchor must match exactly once; idempotency checks the exact injected end states. Runtime dependencies to re-audit after an upstream change: `githubPr.config.listSessionIds` / `getSession`, `githubPr.readBudgets(host).rest`, `ghRest.isKnownHost` / `rest` / `restPaginateWithMeta`, `getGhLogin`, `getAccountStorageDir`, `hasLiveQuery`, `cliGovernor.isAtCap`, `isSendParked`, and `sendMessage`'s `delivered/queued` receipt plus the completion/drop events and the drop reason `cancelled`.

The harness `scripts/tests/community/test-autofix-post-merge.mjs` covers the switch gate, the trust, review and time filters, text hygiene, the window, the REST floor, delivery state and the compiled patch in both orders with the ready-to-merge patch; it does not prove live Electron delivery.
