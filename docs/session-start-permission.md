# Remember session-start approval

On Linux, an ordinary Code `start_session` approval uses a native dialog with three choices:

- **Deny**: nothing starts. Closing the dialog also denies.
- **Allow once**: approve only that call. This remains the default button.
- **Allow always**: approve that call and remember the choice for this Desktop profile, including after restart.

The dialog shows the actual session-start input. The native dialog is an equivalent of the ordinary approval card, not an extra prompt shown before it: the remote claude.ai card deliberately disables persistent choices for its session tools. We do not modify that remote frontend or remove its restrictions globally.

## Scope and revocation

The choice covers **starting sessions only**, across projects in the current Desktop profile. It writes no CLI allow rules and does not approve commands, file access, network access, permission-mode changes or any other actions inside the new session. Existing native permission-mode inheritance and its refusal to start a child in a higher mode remain unchanged. `hand_off_to_session`, `move_to_cloud` and similarly named tools from other MCP servers are not covered.

Revoke it under **Settings → Extra → Community → Starting other sessions → Revoke always allow**. Revocation is immediate, survives restart, and also invalidates an unanswered native dialog. There is no settings-page action that silently grants the permission: it can be granted only by choosing **Allow always** in the main-process native dialog.

The existing Extra config writer saves `alwaysAllowSessionStarts: true` in the current Electron `userData` directory's `claude-desktop-extra.json`. Missing, malformed or non-boolean values mean ask. Other Extra settings, including trusted Auto-fix authors, are preserved. Named profiles and 3P profiles use their own `userData` directories, so grants do not cross those boundaries.

## Restrictions that still apply

The SDK's native `always_ask` policy is left intact. The patch runs only at the ordinary native approval sink, after the broker's pre-card refusals and unattended-session checks. The tool handler and the broker's post-approval validation still run normally.

An existing grant does **not** replace:

- organization policy, explicit ask rules, user/managed PreToolUse hooks, or an unreadable policy result;
- a host or tool-provenance refusal;
- first-use destination consent;
- the native repeated-start count guard or continuation-specific approval reason;
- plan-mode or host-CLI-launcher restrictions;
- any additional mandatory reason shown on the original card.

Those cases retain the original card and its one-shot approval. Rules, including native exact/server/wildcard deny rules and managed-only mode, are re-read before allowing or saving anything. A rule or destination change while the native dialog is open denies that stale call so a retry can show fresh approval information. A failed durable write also denies rather than claiming the permission was remembered. If the dialog or initial policy lookup fails before an answer, the broker falls back to its original approval flow; a failed recheck after an answer denies instead of reusing stale metadata.

## Validation and upstream assumptions

Validated anchors target upstream **4.16336.0**. The Nim patch matches the six-argument Code permission broker and its native-card request sink exactly once. It fails if either moves, and idempotency checks the full generated injection, not the absence of an old pattern. Re-audit the SDK explicit-ask reader (`_K` in that release, which excludes the server's own `mcpServerPolicy` but includes other ask rules and hooks), host-launcher classifier, force-ask verdict and first-destination logic on upstream changes.

The harness `scripts/tests/core/test-session-start-permission.mjs` exercises the compiled injection and the real Extra config writer with isolated profiles, separate Node main-process shims and a mocked Electron dialog. It covers persistence/restart, revocation/races, one-shot consent, cancellation, preservation of unrelated config, SDK server-policy-only asks and native-policy fallbacks. The continuation/remote/count guard and the deny-rule matcher are resolved from upstream rather than reimplemented. This does not claim an interactive Electron install/restart test.
