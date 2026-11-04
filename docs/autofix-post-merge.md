# Comments after merge

Auto-fix continues forwarding new comments on a **MERGED** GitHub PR to its owning Code session while that session remains active and its Auto-fix binding is enabled. It uses `AutoFixEngine.sweep` and the existing `ci-monitor` send queue; it adds no timer, cron job or parallel poller. Linux only; no display-server or architecture-specific paths.

## Information is not authorization

Post-merge notices are deliberately separate from the ordinary Auto-fix fix-and-push prompt. They identify the PR and quote feedback, but expressly grant **no authorization** to change code, commit, push, reply on GitHub, open another PR, merge or deploy. The agent reports the feedback and awaits separate user authorization for action. Third-party author/body text is normalized, control characters removed, opening angle brackets escaped and every line quoted. At most 20 comments, each body bounded to 1,600 characters, are delivered per notice; subsequent sweeps drain the remainder.

Issue comments, inline review comments and review summaries are included, regardless of author association. The currently authenticated GitHub user's own comments and empty bodies are excluded. Editing an existing comment is not a new comment. Review summaries use `submitted_at`; other comments use `created_at`. Only timestamps strictly after GitHub's `merged_at` and at or after this feature's initial account activation are eligible. Old history is **not** replayed when installing this feature. Comments that arrived while the app was stopped after activation can be recovered on the next sweep.

## Archived sessions and ownership

**Archived sessions do not poll GitHub and do not wake.** No session is automatically unarchived, no human-only notification substitutes for agent delivery, and no autoarchive preference is changed. If a session is later unarchived, it can receive eligible pending comments. If it stays archived, no polling is performed on its behalf. A separate configurable autoarchive delay can provide a post-merge window; this patch does not implement or assume one.

Inherited, dismissed, unconfirmed, disabled or non-GitHub bindings are excluded, as are sessions explicitly stopped until a person sends. A single owner is selected for duplicate bindings (existing owner, otherwise earliest session, stable ID tie-break). An archived owner's binding does not silently transfer to an active duplicate. Explicit removal or disabling of the old binding permits another eligible owner. Removing all bindings stops delivery. `CLOSED` without merge and open PRs stay outside this helper.

## Persistence and failure handling

The atomic, mode-0600 `autofix-post-merge.json` ledger lives in the app's **account/org storage directory**, itself scoped by Electron userData/profile. Keys include GitHub host, repository and PR number, not HEAD SHA: a new HEAD cannot replay comments. Switching accounts cannot send an in-flight response into the new account. A successful merged-state read confirms repository identity, PR number and merge time; all calls use the binding's configured host and the app's existing authenticated REST client.

Seen comment IDs, pending batch IDs and message UUIDs survive restart. A queued send is not considered seen until completion (or explicit user cancellation, which dismisses it). Lost sends retry; a surviving parked send is not duplicated. An unconfirmed send lost across restart is retried with the same UUID: delivery is **at least once**, not an exactly-once claim across a crash between acceptance and the receipt write. A failed or rejected send never consumes comment IDs. Missing authentication, unknown hosts, incomplete pagination and malformed/corrupt storage fail closed. Storage failures never cause an untracked send.

The helper observes upstream REST rate limits and leaves at least 20 requests of known headroom, reads each active merged PR at most once per minute, and backs failures off up to 30 minutes. Each read checks the PR plus three conditionally cached paginated comment endpoints; no GraphQL scan is added. Concurrency is capped at five targets, matching the existing engine batch size. The app's CLI cap and stopped/archived/binding checks remain in force before delivery. Diagnostics use `[post-merge]` in `claude-patches.log`, without logging comment bodies or credentials.

Validation: `node scripts/tests/core/test-autofix-post-merge.mjs`, the core/community feature harnesses, the pristine absorption probe and full patch application with JavaScript syntax checks. No installation/restart is required for these checks; a live Electron test is a separate step.
