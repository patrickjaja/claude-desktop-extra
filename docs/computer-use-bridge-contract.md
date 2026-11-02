# Computer Use bridge CLI contract (v1)

claude-desktop-extra bundles one or more Computer Use bridge binaries next to the app in `resources/` (`x11-bridge`, `wlroots-bridge`, `gnome-portal-bridge`, `kwin-portal-bridge`). The launcher (`--diagnose`, `--reset-screen-sharing`) and the Computer Use executors talk to every bridge through the same command-line contract, so a bridge can be added, replaced or updated without per-bridge code in claude-desktop-extra. `scripts/check-bridge-contract.sh` enforces it in CI.

## General rules

- Every successful command prints exactly one JSON value on stdout and exits 0.
- A runtime error exits 1 with a human-readable message on stderr and nothing on stdout.
- Bad usage (unknown subcommand, bad flag) exits 2.
- Contract-specific exit codes for bridges with a portal session:
  - **3**: the target monitor is not shared in the live portal session. stderr: `monitor <ID> (<x>,<y> <w>x<h>) is not shared in the portal session (shared: <ID> at <x>,<y> <w>x<h>[, ...])`. A shared entry may be named `stream-<node>` when the bridge cannot map a stream to a monitor. The bridge adds no remedy text; consumers add their own.
  - **4**: no live session (the session daemon is gone).
  - **5**: screen sharing was stopped (the portal session was closed from the desktop's screen-sharing indicator, or by the desktop). The bridge records this in `${XDG_RUNTIME_DIR:-/tmp}/<bridge>/stopped-by-user`; while that marker exists, input and capture commands (and any command that would otherwise need a portal session, such as `screens` without Mutter) exit 5 and never open a portal session of their own. stderr: `screen sharing was stopped (the portal session was closed by the user or the desktop)`. Exit 5 also covers the desktop ending the session itself, e.g. when a shared monitor is unplugged. A `session-start` whose new daemon is closed before it becomes ready also exits 5. `session-start`, `session-end` and `forget-session` remove the marker.
  Consumers switch on the exit code; text matching is only a fallback for bridges below contract 1.
- `--version` prints `<bridge> <semver>`.
- Every coordinate flag (`--x`, `--y`, `--from-x`, `--from-y`, `--to-x`, `--to-y`, region origins) accepts negative values.
- `doctor`, `screens`, `windows`, `session-end` and `forget-session` never open a portal session and never show a consent dialog.
- File layout for bridges with a session:
  - restore token: `${XDG_STATE_HOME:-$HOME/.local/state}/<bridge>/restore-token.json`
  - session socket: `${XDG_RUNTIME_DIR:-/tmp}/<bridge>/session.sock`
  Both are reported by `doctor`; consumers do not hardcode them.

## Commands

### `doctor`

Exits 0 even when the display server, compositor or session bus is unreachable. Required keys (consumers read only these; bridge-specific keys may follow at the top level):

| key | type | meaning |
|---|---|---|
| `contract` | number | `1` |
| `bridge` | string | binary name, e.g. `gnome-portal-bridge` |
| `version` | string | semver |
| `backend` | string | `x11`, `wlroots`, `gnome-portal` or `kwin-portal` |
| `session_match` | bool | the bridge's own check says it serves the current graphical session |
| `backend_reachable` | bool | the display server / compositor / portal answered |
| `backend_error` | string or null | why not, when unreachable |
| `session_supported` | bool | the bridge has a persistent session / screen-sharing grant |
| `restore_token_present` | bool | a remembered grant exists (false when unsupported) |
| `restore_token_path` | string or null | path of the grant file (null when unsupported) |
| `daemon_running` | bool | a session daemon answers on its socket |
| `session_socket` | string or null | socket path (null when unsupported) |

Optional key: `stopped_by_user` (bool) - the stopped-by-user marker exists.

### `screens`, `windows`

Shapes are frozen. `screens` returns an array of `{id, name, geometry{x,y,width,height}, scale, refresh_millihz, is_active, is_primary}`; `is_shared` is optional (absent = unknown).

### `session-start [--foreground]`

`{"ok": true, "session": "daemon" | "noop"}`. Never prints a restore token. When a session daemon is already running, a bridge with sessions exits 1 with a stderr message containing `already active`; consumers that only need a session to exist treat that as success.

### `session-end`

`{"ok": true, "ended": <bool>, "daemon": "exited" | "sigterm" | "sigkill" | "shutdown-requested" | "none"}`. `ended` is true only when a daemon was actually there.

### `forget-session`

Ends a running session daemon (same reaping as `session-end`) and deletes the remembered grant. Output: the `session-end` keys plus `"token_removed": <bool>, "token_path": <string or null>`. Must not create directories, must not call D-Bus, must be idempotent (exit 0 when there is nothing to remove).

Bridges without a session (`session_supported: false`) answer exactly:

```json
{"ok":true,"ended":false,"daemon":"none","token_removed":false,"token_path":null}
```

## Optional: accessibility (AT-SPI) commands

Bridges may add four commands that read and act on a window's accessibility tree. They are additive and optional: contract v1 does not change, and a consumer calls them only when the bridge has them. All four bridges (x11, wlroots, kwin, gnome) implement them with the shared `cu-atspi` crate.

- `ax-enable --holder-pid <pid>` turns the desktop accessibility service (`IsEnabled`) on for a long-lived holder process (Claude's main process, not the short-lived bridge) and remembers the previous value. A screen reader that is running is never touched. Output carries `previous`, `changed`, `screen_reader`, `holders`, and a `reason` when nothing changed.
- `ax-restore --holder-pid <pid>` drops the holder and turns the service back off only when it was ours and no other holder is left. Always safe to call; a no-op when there is nothing of ours.
- `ax-find --window <id> [--role R] [--title-contains T] [--all] [--include-hidden] [--max-nodes N] [--max-depth N]` lists a window's elements (role, name, states, value, position) and returns an opaque `scope` plus a `ref` per element. `<id>` is an id from `windows`. The gnome bridge, whose window list carries no ids on stock GNOME, takes `--app-id <id> [--title <t>]` instead of (or with) `--window`.
- `ax-action --scope <scope> --ref <ref> --action click|focus|set-text` acts on an element from `ax-find`. For `set-text` the text is read from stdin (whole, UTF-8, untrimmed) and never from argv.

Exit codes: a missing a11y bus, a screen reader, an unknown or ambiguous window, a stale element or an unsupported action is an **unavailable result** (a JSON object with an `unavailable` reason, exit 0), not an error. Bad usage, including invalid UTF-8 on the `set-text` stdin, exits 2. Other runtime errors exit 1.

`doctor` may add the optional key `atspi`: `{"bus": <bool>, "is_enabled": <bool>, "screen_reader": <bool>}`, plus `error` when the session bus is unreachable. It never activates the accessibility bus and never fails the command; on a hung bus it can take up to 5 seconds, so callers use a timeout above that.

## Older bridges

A bridge whose `doctor` exits 2 or has no `contract` key is contract 0: consumers fall back to their per-bridge behaviour. A `forget-session` that exits 2 means the bridge cannot reset its grant; the launcher says so and tells the user to update.
