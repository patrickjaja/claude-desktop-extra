# Native dialog with "Allow always" for starting other sessions

When Claude asks to start another Code session (`start_session`), upstream asks every time and never offers a lasting approval. It withholds it in the main process: the permission broker puts the session tools in its set of tools that never get a lasting rule, and the SDK server marks `start_session` and `hand_off_to_session` with the `always_ask` permission policy (GrowthBook `3650263018`, on by default). This opt-in switch adds a native dialog that can remember the approval for one project.

## The switch

Settings -> Extra -> Community Features -> **Native dialog with 'Allow always' for starting other sessions** (section "Code"). Off by default: off is upstream's in-chat card, unchanged. It applies live. The setting is the `sessionStartAlwaysAllow` key in `<userData>/claude-desktop-extra.json`; a boolean for the same key in the hand-owned `claude-desktop-extra.jsonc` wins and locks the switch. Linux only.

## The dialog

For an eligible ask, a dialog opens on the app window (modal to it; the window is shown and focused first) with three buttons:

- **Deny** - the default button. Escape and closing the dialog also deny.
- **Allow once** - this call only.
- **Allow always** - this call, and later ones from the same asking project to the same displayed local destination. The default destination and each explicitly named directory have separate approvals.

It names the new session's title, the asking session, the project, the destination, the child's permission mode and model (when given), and the first 300 characters of the prompt Claude wrote.

## What "Allow always" covers

A remembered approval is keyed by the asking session's project folder (`originCwd`, else `cwd`; exact path, the way upstream names a session's project for start targets) and applies only when:

- the switch is on;
- the request targets this computer: no `host`, `environment`, `preset` or `repository`, and `target` is absent or `"local"`;
- `cwd` is absent (the existing default-destination approval), or is an absolute path to an existing local directory. An explicit directory is resolved with `realpath` and has a separate grant keyed by `[asking project, resolved destination]`. A default grant does not cover it, nor does it cover any other directory or asking project;
- `permission_mode` is absent or at or below the asking session's mode (upstream's own ranking; an unknown mode does not qualify);
- the asking session runs on this computer (not SSH, WSL or a remote target).

A request outside that scope shows upstream's card, even when the project has a remembered approval. Sessions started this way run in this session's permission mode (or a lower one) from a prompt Claude wrote; nothing inside them is approved by this. No CLI rule or child-session permission is written.

Remembered approvals live under `sessionStartGrants` in `<userData>/claude-desktop-extra.json` (project folder, or serialized `[project, destination]` tuple -> `{ grantedAt }`), at most 50 in total, newest kept. Existing default-destination keys remain valid without migration. Only the dialog adds one; the settings row shows how many there are and has **Forget remembered approvals**. Switching the row off forgets them too, and a stored approval is ignored while the switch is off. Named and third-party profiles use their own `userData`, so approvals do not cross profiles.

## When upstream's card asks instead

The dialog is only used where upstream would show its ordinary card. Everything else keeps the card and its one-shot approval:

- the switch is off;
- the app window is hidden (to the tray), minimized or gone;
- a request outside the scope above;
- non-rule decision reasons other than the exact native first-use sentence for an explicit local directory, managed-only rules, deny rules (matched by upstream's own rule matcher), explicit ask rules or external PreToolUse hooks, organization policy;
- unproven tool provenance, continuation, remote-control or unattended sessions, the repeated-start count guard (10), plan mode, the host CLI launcher.

For a first-use explicit local directory, the dialog includes the broker's own destination-consent sentence. It always asks visibly, even if a remembered start exists, and only an actual click marks the result as on-card consent for upstream's unchanged destination-grant processing. Matching a destination sentence does not override external ask rules or hooks. A changed destination/consent, including a symlink retargeted while the dialog is open, denies rather than saving a stale approval. No folder is silently added to a global trust list.

## Fail directions

- Before the person answers, any failure (rules unreadable, no window, the dialog failing) returns to upstream's card. It never allows.
- After the person answers, any failure denies: the rules are re-read, and a changed policy, a revoked approval, the switch turned off, a cancelled request or a failed write of the remembered approval denies that call so a retry asks again.
- Upstream's cancellation signal closes the dialog. A dialog left open keeps the call pending, like the card.

## Validation and upstream assumptions

Validated against upstream **4.16336.0**. The patch (`patches/community/add_feature_session_start_always_allow.nim`) matches the six-argument broker method and its card sink once, and asserts that the broker's start gate is in the broker's chunk and that every namespace export the hook calls (`TF`, `_K`, `hm`, `qn`, the rule matcher, and `Xmt` = the `MAIN_WINDOW` BrowserWindow) is defined in the chunk the broker requires that namespace from. A layout change fails the build. Idempotency checks the full generated injection.

The harness `scripts/tests/community/test-session-start-permission.mjs` covers the settings half, the helper's scope, window and fail rules, the compiled patch on a synthetic staged bundle (including the layout assertions), and, when `tmp/app.asar.contents` is present, the real 4.16336.0 broker method, start gate and rule matcher driven through an ordinary ask. It does not prove an interactive Electron dialog.
