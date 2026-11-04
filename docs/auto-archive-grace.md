# Auto-archive delay after PR merge or close

**Linux, validated against upstream 4.16336.0.** Settings → Extra → Community Features → **Auto-archive delay after PR merge or close** augments the native Code session PR auto-archive rule.

## Configure

Presets: **Immediately (default), 5 minutes, 15 minutes, 30 minutes, 1 hour**. **Custom minutes** accepts whole numbers from **1 to 10080** (one week). The main process validates IPC input too. Invalid input is not saved.

This does **not** enable auto-archive. The existing global preference and each session's `auto_archive_on_close` override still decide whether that session can auto-archive. The delay covers **both MERGED and CLOSED without merge**. Auto-fix, comment delivery and auto-merge are unchanged; no additional GitHub reads or timers are created. This feature does not poll or revive archived chats.

The setting is stored in the profile's `claude-desktop-extra.json` as `autoArchiveMergeDelayMinutes` (the existing key name is retained; it now covers both terminal states). Zero removes the key. A hand-edited value in `claude-desktop-extra.jsonc` overrides it and locks the row. Hand edits apply live; invalid hand-edited values resolve to the immediate default. Existing keys, including trusted PR authors, are preserved.

## Grace semantics

- The clock starts when a native archive sweep first confirms the session's PRs are terminal (merged or closed), **not** at GitHub's historical merge/close timestamp. Discovering a merge or close after restarting/offline therefore grants a full grace period if none was previously recorded. An archive candidate's fresh native PR lookup can also start the clock.
- The profile-local `cdb-auto-archive-grace.json` records the start and the exact owned binding set (provider, host, repository and PR number). Writes use a private temporary file and atomic rename. Restarting does not reset or shorten a previously recorded grace. Time while the app is closed counts toward expiry.
- The native auto-archive sweep remains responsible for archival: normally every five minutes, plus native event kicks. Expiry makes the session eligible on the **next** sweep; it is not an exact-minute alarm. All existing holds (running turn, visible/pinned chat, awaiting input, child sessions, worktree safety, etc.) still apply. The clock can run while the session is held.
- Changing the delay recalculates expiry from the **same original confirmation**. Shortening can make an existing grace immediately eligible on the next sweep; lengthening extends it. Selecting Immediately clears its record when next processed.
- A native PR-auto-archive opt-out, manual archive, removed session or changed owned binding set cancels the saved grace when observed by the native sweep. A newly confirmed terminal binding gets its own new start. Re-enabling after an observed cancellation starts a new grace. Changes made and undone entirely between observations cannot be detected.
- A fresh native nonterminal answer (for example a reopened PR) clears the grace without archiving. A subsequent close starts a fresh grace. Mixed terminal binding sets follow the native terminal verdict and receive the same grace.
- With a nonzero delay, storage failure/corrupt grace state prevents the PR archive gate from proceeding and logs `[archive-grace]` diagnostics in `claude-patches.log`; it does not silently discard the grace. A failed state write is retried on later native sweeps. Selecting Immediately restores native behavior even if a leftover ledger is corrupt.

## The separate native inactivity rule

CDE also has **Archive inactive sessions** in its native Code settings. It archives local chats after the configured number of days without activity **or attention**, independently of whether they have a PR. Zero disables it; upstream's default is zero. The native engine compares the most recent activity (or creation time when missing) and the last time the chat was focused against that threshold, and applies its own safety holds.

This patch does not change that preference or that rule. **Inactivity can independently archive a chat during its PR grace period** if its own native criteria are already satisfied. This is separate from the PR completion rule, not an extra timeout introduced by this feature.

No installation, restart, merge, deployment or trusted-author allowlist change is part of configuring or testing this patch.

## Implementation and validation

- [`add_auto_archive_grace.nim`](../patches/core/add_auto_archive_grace.nim) wraps only `AutoArchiveEngine`'s sweep and guards the existing PR archive pipeline before any background tasks are stopped or cleanup begins. It checks all five anchors, including cancellation on the native fresh-reopen recheck, and verifies its exact injected end state on rerun.
- [`auto_archive_grace.js`](../js/auto_archive_grace.js) handles profile-local persistence and binding/opt-in reconciliation, without network requests.
- Extra settings' existing authenticated IPC/preload and row styles provide the editor; this adds no new UI framework or permissions.
- [`test-auto-archive-grace.mjs`](../scripts/tests/core/test-auto-archive-grace.mjs) covers clocks/restart, binding and opt-in changes, MERGED/CLOSED/reopen, unchanged inactivity, invalid values, failure safety, actual compiled injection, idempotency and settings persistence. [`test-extra-settings-dom.mjs`](../scripts/tests/core/test-extra-settings-dom.mjs) exercises presets/custom input in Chromium.
