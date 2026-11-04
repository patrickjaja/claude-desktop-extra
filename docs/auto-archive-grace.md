# Auto-archive delay after a PR merges or closes

**Linux, validated against upstream 4.16336.0.** Settings -> Extra -> Community Features -> **Auto-archive delay after a PR merges or closes** holds upstream's own PR auto-archive for a while after a Code session's PR merges or closes, so the chat stays in the sidebar long enough to read the outcome.

## Configure

Presets: **Immediately (default), 5 minutes, 15 minutes, 30 minutes, 1 hour**. **Custom minutes** accepts whole numbers from **1 to 10080** (one week). The main process validates the value too; an invalid one is not saved. Immediately is upstream's behavior: nothing is read, written or delayed.

This does **not** turn auto-archive on. Upstream's global preference and each session's own override still decide whether a session auto-archives at all. The delay covers a PR that merged and a PR that closed without merging. Upstream's separate inactivity rule ("Archive inactive sessions") is unchanged and can still archive a chat during its grace if its own criteria are met.

The value is stored in the profile's `claude-desktop-extra.json` as `autoArchiveMergeDelayMinutes`; Immediately removes the key. A valid whole number (0-10080) in `claude-desktop-extra.jsonc` wins and locks the row. Any other value there is ignored and the row shows a warning. Changes apply from the next sweep.

## When the session is archived

- The clock starts the first time upstream's archive sweep confirms the PR merged or closed, not at GitHub's own merge or close time. A merge seen for the first time after a restart therefore still gets the full delay.
- Upstream sweeps every 5 minutes, plus on its own session events. When the delay expires, the session is archived on the next sweep, so the archive can come up to 5 minutes after the delay ends. It is not an exact-minute timer.
- During the grace, the session leaves the sweep early. Upstream's PR state lookup, its re-read of a "last seen closed" PR, its check for an unrecorded PR (GitHub reads), its share of the per-sweep GitHub budget and its worktree inspection (git) are all skipped. When the delay expires, all of them run in full, along with every upstream hold (running turn, pinned or on-screen chat, awaiting input, live side sessions, unsaved work, worktree safety). The one exception is a close upstream could not confirm yet: its confirmation (a GitHub read) runs first on every sweep, and the delay applies after it.
- Changing the delay recalculates from the same start. A shorter delay can make a session eligible on the next sweep, and a longer one extends the grace. Choosing Immediately drops every pending grace on the next sweep.
- A grace ends without an archive when upstream reads the PR as open again (a confirmed reopen), when auto-archive is switched off for the session, when the session is archived by hand or deleted, or when its own PR bindings change. A later merge or close then starts a new grace.
- Only a positive answer ends a grace. When upstream cannot read the PR, finds no PR, or sees a close it cannot confirm, the grace and its start time stay as they are.

## State and failures

The profile's `cdb-auto-archive-grace.json` holds each pending grace: its start time and the session's own PR bindings (provider, host, repository, PR number). It is written atomically with mode 0600. A restart neither resets nor shortens a grace, and time while the app is closed counts.

If that file cannot be read or written while a delay is set, a merged or closed PR is held rather than archived early, and `[archive-grace]` lines in `claude-patches.log` say why. Choosing Immediately restores upstream's behavior even with a broken file.

## Implementation

- [`add_feature_auto_archive_grace.nim`](../patches/community/add_feature_auto_archive_grace.nim) wraps `AutoArchiveEngine`: a wrapper around its sweep (reads the delay once per sweep, reconciles the ledger after it), a gate for a confirmed MERGED/CLOSED verdict placed before upstream's GitHub and git pre-archive work, a check that skips the PR lookup while a known verdict is in its grace, a gate for an unconfirmed close placed after upstream confirms it, a hook that passes non-terminal answers to the helper, and a cancel on upstream's confirmed-reopen path. Every anchor must match exactly once, and a rerun checks that each injection is present at its site.
- [`auto_archive_grace.js`](../js/auto_archive_grace.js) keeps the profile ledger; it makes no network requests and starts no timers.
- [`test-auto-archive-grace.mjs`](../scripts/tests/community/test-auto-archive-grace.mjs) covers the ledger, the non-answer rule, reopen, restart, failures, the compiled injection against a fixture of upstream's shapes (including what runs during and after the grace), idempotency and the settings IPC. [`test-extra-settings-dom.mjs`](../scripts/tests/core/test-extra-settings-dom.mjs) covers the row, its presets, custom input and the locked state.
