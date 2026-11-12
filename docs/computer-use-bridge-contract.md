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

## Optional: allowlist mask (`screenshot` / `zoom`)

Bridges may let a capture keep only some windows. Additive and optional: contract v1 does not change, and a consumer passes the flags only when `doctor` says the bridge has them. x11-bridge and wlroots-bridge (sway, Hyprland) implement it.

- `screenshot` and `zoom` take `--keep-window <id>` (repeatable; ids from `windows`) or `--mask-all` (keep nothing). The two conflict (exit 2). Without either flag the capture and its output are unchanged.
- Every pixel outside a kept window's visible region is painted over (a solid fill): the desktop, panels and bars, other apps' windows and Claude's own window, unless kept.
- The result adds `mask` with at least `mode` (`"keep"` or `"all"`) and `kept`. Bridge-specific keys follow:
  - x11-bridge: `{mode, fill, kept: [id], kept_hidden: [id], kept_missing: [id], auto_kept: [id], masked: [{id, frame, pid, desktop_file_name, resource_class, resource_name, override_redirect}]}`. `masked` lists the masked windows with pixels in the image, topmost first, by client id as in `windows`; titles are never reported.
  - wlroots-bridge: `{mode, capture, kept: [{id, appId, title, visible, shown, reason, coveredBy, pid}], regions: [{x, y, width, height}], children, childrenSkipped}` (details below). Its ids are positional per-connection protocol ids that can shift between `windows` and the capture (Hyprland announces windows in its window-list order, which changes with focus), so the caller lists `windows` right before the masked call and `kept` echoes the app id, title and pid each kept id named at capture time.
- Fail closed: a bridge that cannot build the mask exits 1 with no image (never an unmasked one).
- x11-bridge only, optional: `--ignore-window <id>` (repeatable, mask mode only) names a see-through overlay of the caller (Claude's Computer Use glow and teach overlay) to treat as absent: it is neither kept nor masked and hides nothing below it, so a kept window under it keeps its pixels (as composited: the overlay's own rim or card over the app). An id is honoured only for a viewable override-redirect window whose `_NET_WM_PID` is the bridge's parent process and that is not kept; anything else stays an ordinary masked window. The `mask` report adds `ignored: [id]`, `ignored_missing: [id]` and `ignored_refused: [{id, reason, pid?, caller_pid?}]` (`reason`: `kept`, `not_override_redirect`, `no_pid`, `foreign_pid`, `no_caller_pid`). `doctor` advertises it with `capabilities.screenshot_mask_ignore: true`.
- x11-bridge only, optional: `doctor` reports `capabilities.compositing`: `true` when a compositing manager runs on the screen now (the `_NET_WM_CM_S<screen>` selection has an owner), `false` when none does, `null` with `compositing_error` when it cannot tell (no display). It is read on every `doctor` call. Consumers treat `false` and `null` alike: no compositor, so no see-through windows (claude-desktop-extra keeps the glow off then).
- `doctor` advertises it: x11-bridge `capabilities.screenshot_mask: true`; wlroots-bridge top-level `screenshot_mask: true` plus `screenshot_mask_gaps` (string list, what the mask cannot cover; see below). A missing key means no support.

### wlroots-bridge mask report

`doctor` always prints two more top-level keys: `screenshot_mask_mode` (`"toplevel"`, `"output"`, or null when no compositor was reached or the bridge cannot mask on this compositor, e.g. niri, river) and `screenshot_mask_protocol` (`"ext-image-copy-capture-v1"`, `"hyprland-toplevel-export-v1"`, or null). `"toplevel"` always comes with a protocol. They say how a keep-window capture is made:

- `"toplevel"` (Hyprland): each kept window that is drawn on the captured output is captured on its own (the ext protocol on Hyprland 0.54+, Hyprland's own export protocol before) and drawn back to front onto a solid canvas. No layer surface, notification, other window or cursor is in the image, and nothing hides the window.
- `"output"` (sway, and every compositor without per-window capture): the composited output is captured and everything but the kept windows' visible regions is painted over.

`screenshot_mask_gaps` per mode: `toplevel` lists `popups_outside_window` (a kept window's own popups are clipped at its box) and, where X11 pop-ups cannot be attributed, `xwayland_unmanaged`; `output` lists `popups` on Hyprland, and `popups`, `layer_shell_top_overlay` and `xwayland_unmanaged` on sway.

The `mask` object of `screenshot|zoom --keep-window`:

- `capture`: `"toplevel"` or `"output"`; missing means `output`. A bridge whose `doctor` says `toplevel` may answer `output` for one call (a captured buffer that does not match the window's rectangle falls back to the output cut).
- `kept[]` = `{id, appId, title, visible, shown, reason, coveredBy, pid}`:
  - `shown`: the window's pixels are in the image.
  - `reason`, when not shown: `other_workspace`, `minimized`, `other_output`, `covered` (both modes: in output mode the cut left nothing; in both, a window on a shown workspace that the compositor does not draw, such as a hidden tab or group member). `capture_failed` is reserved: a failed capture is a bridge error (exit 1, no image).
  - `coveredBy`: app ids (`unknown` without one) of windows, and `layer:<namespace>` of top/overlay layer surfaces, whose rectangle meets the window's. Conservative: layers are judged by rectangle only.
  - `pid`: the window's process id from the compositor snapshot the capture used, or null.
- `regions`: in `output` mode the visible regions kept after the cut; in `toplevel` mode the destination rectangles of the shown windows.
- `children: [{address, pid, parent, rect}]` and `childrenSkipped` (a count), `toplevel` mode on Hyprland: X11 override-redirect windows (menus, dropdowns) of a shown kept X11 window. One is drawn only when its process owns no non-kept window and it touches its parent (`parent` = the kept id).
- A result where no window is shown is still a well-formed image (all mask colour) with exit 0; `kept[]` says why.

An executor without `shown` (an older bridge) derives it from `visible` and an empty `regions`.

How claude-desktop-extra uses the report (`js/cu_linux_executor.js`): it discards the image when a field has the wrong type, when a kept entry or a child fails its checks (kept id not asked for, app not allowed, a window reported twice, a shown window that was reported not visible, a child whose parent is not a shown kept window or whose pid differs from that window's), and turns "nothing shown" into a text naming the reason per approved app instead of the image. Covered windows are shown whole; a short note next to the image names the apps in front of one (in `toplevel` mode layer surfaces alone are not mentioned, in `output` mode everything that was cut away is). Window ids must come from a `windows` call made right before the masked call. A report that disagrees with that window list (a kept or child entry naming a window that was not asked for, an app that is not allowed or Claude's own window, a different number of kept entries, a child pid that is not its window's) is retried once with a fresh `windows` call, every check applying again; a malformed report is not retried. The model never sees window ids, app ids, pids or the bridge's name in these refusals; the detail is in `claude-patches.log`. Upstream's "Entire screen" pseudo-grant (`com.anthropic.cu.screen`) is not an app: it is never kept, named or counted as an approved app.

The build checks the bridge: `scripts/check-bridge-contract.sh --wlroots-caps <wlroots-bridge>` requires `screenshot_mask_mode` and `screenshot_mask_protocol` in the `doctor` answer (and a `toplevel` mode with a protocol), so a build with an older wlroots-bridge fails.

How claude-desktop-extra uses it (js/cu_linux_executor.js): when the caller passes the granted apps (`allowedBundleIds`: upstream's own dispatch always, the Code-session handler with "Ask before Computer Use controls an app" on), the windows of those apps are kept (never Claude's own), `--mask-all` when none is on screen. A `doctor` that fails, any bridge error, an exit 2 from a bridge without the flags, a result without `mask`, or (wlroots) a kept entry whose app id is no longer an allowed app discards the capture; no other capture tier is tried. A backend that definitively cannot mask (no capture bridge: GNOME, XWayland-only, the Electron fallback; or a `doctor` without the key: niri, river, an older bridge) captures unmasked. Every capture result carries `masked` (true / false), `filtering` (`"mask"` / `"none"`) and `maskGaps`; `capabilitiesNow().screenshotFiltering` is the cached `doctor` answer.

With x11-bridge's `screenshot_mask_ignore`, the executor passes the XIDs of Claude's own visible overlay windows (the BrowserWindows showing upstream's `cu-glow.html` and `cu-teach-<n>.html`) with `--ignore-window`, on the host display only (never to a background display), and discards a result whose `ignored` names an id it did not pass. Without the capability the overlay stays above every app and the masked image shows none of them; `claude-patches.log` says so once per bridge.

x11-bridge kept windows are checked by id only (`kept` must be a subset of the ids asked for). That is sufficient on X11: the bridge captures under a server grab, and an XID comes from its client's own resource-id range, so the id of a window that vanished between `windows` and the capture can only come back as a window of the same client, never another app's. wlroots-bridge ids are per-connection protocol ids with no such guarantee, hence its `appId` / `title` echo and the executor's re-check.

## Optional: window geometry keys

`windows` entries keep the frozen shape; bridges that can locate windows fill `geometry` (global logical px on Wayland, root px on X11, the space `screens` uses), `output` (a `screens` id), `is_visible` (false for other workspaces, hidden tabs, minimized) and `stacking_order` (back-to-front rank). A bridge that cannot locate a window reports `geometry` `{0,0,0,0}` and `output` null for it; consumers never guess a position.

wlroots-bridge `doctor` adds `window_geometry: true` when the compositor IPC answered (sway `GET_TREE`, Hyprland `j/clients`); niri, river and others report false. claude-desktop-extra then uses the geometry for the display auto-target and for a hit test (`appUnderPoint`, topmost window by `stacking_order`; unknown while any non-minimized window has no position).

`app-under-point --x X --y Y` answers `{bundleId, displayName}` of the app whose window takes the click at the point, or JSON `null` when no window does (bare desktop). A point on a window's frame (title bar, its buttons, borders of a reparenting window manager) answers for that window's client, exactly as its client area does; the invisible shadow margin of a client-side-decorated window (`_GTK_FRAME_EXTENTS`) is not part of the window, and a window whose input shape does not contain the point (Claude's click-through glow) is looked through. A client that names no app answers its own client window id (decimal, as in `windows`), never a decoration window's id; claude-desktop-extra resolves it through the window list and its process, and otherwise answers upstream's explicit "unattributed window" refusal. x11-bridge does this since 2026-11-11 (`doctor` reports `capabilities.input_shape`); older builds answered a frame point with the decoration window's numeric id, which no grant matches.

## Optional: accessibility (AT-SPI) commands

Bridges may add four commands that read and act on a window's accessibility tree. They are additive and optional: contract v1 does not change, and a consumer calls them only when the bridge has them. All four bridges (x11, wlroots, kwin, gnome) implement them with the shared `cu-atspi` crate.

- `ax-enable --holder-pid <pid>` turns the desktop accessibility service (`IsEnabled`) on for a long-lived holder process (Claude's main process, not the short-lived bridge) and remembers the previous value. A screen reader that is running is never touched. Output carries `previous`, `changed`, `screen_reader`, `holders`, and a `reason` when nothing changed.
- `ax-restore --holder-pid <pid>` drops the holder and turns the service back off only when it was ours and no other holder is left. Always safe to call; a no-op when there is nothing of ours.
- `ax-find --window <id> [--role R] [--title-contains T] [--all] [--include-hidden] [--max-nodes N] [--max-depth N]` lists a window's elements (role, name, states, value, position) and returns an opaque `scope` plus a `ref` per element. `<id>` is an id from `windows`. The gnome bridge, whose window list carries no ids on stock GNOME, takes `--app-id <id> [--title <t>]` instead of (or with) `--window`.
- `ax-action --scope <scope> --ref <ref> --action click|focus|set-text` acts on an element from `ax-find`. For `set-text` the text is read from stdin (whole, UTF-8, untrimmed) and never from argv.

Exit codes: a missing a11y bus, a screen reader, an unknown or ambiguous window, a stale element or an unsupported action is an **unavailable result** (a JSON object with an `unavailable` reason, exit 0), not an error. Bad usage, including invalid UTF-8 on the `set-text` stdin, exits 2. Other runtime errors exit 1.

`doctor` may add the optional key `atspi`: `{"bus": <bool>, "is_enabled": <bool>, "screen_reader": <bool>}`, plus `error` when the session bus is unreachable. It never activates the accessibility bus and never fails the command; on a hung bus it can take up to 5 seconds, so callers use a timeout above that.

## Optional: abort watcher (`abort-watch`)

x11-bridge, wlroots-bridge and kwin-portal-bridge add a long-running `abort-watch` subcommand that reports the user's physical Escape press, for the opt-in [Escape stops Computer Use](cu-escape-abort.md) switch. Additive and optional: the app starts it without asking `doctor` first, and a bridge without it answers with a usage error, which the app treats as "cannot arm". The implementation is the shared crate [`cu-abort-watch`](https://github.com/patrickjaja/cu-abort-watch), which also documents the protocol in full.

- stdout, one JSON object per line: `{"event":"ready","mechanism":"xi2|sway|hyprland|kglobalaccel","syntheticSafe":<bool>}` once armed, `{"event":"abort"}` per press, `{"event":"ack","cmd":"suspend"|"resume"}`, `{"event":"error","message":...}`. `syntheticSafe: true` means an Escape the model injects can never produce an `abort`.
- stdin, one command per line: `suspend` (stop reporting and consuming Escape) and `resume`.
- Exit codes: 0 on stdin EOF, SIGTERM/SIGINT/SIGHUP or the parent's death (`CLAUDE_CU_PARENT_PID` names the process to watch); 1 on a runtime failure after an `error` line; 2 when arming failed, after an `error` line, with nothing left behind.
- Nothing is left bound on exit; binds shared by several profiles are healed by the next first holder.
- `doctor.abortWatch` says whether and how this bridge can watch on the current session.

## Optional: glow overlay (`overlay`)

A bridge may draw Claude's "Claude is using your computer" glow and drawn cursor on its compositor. Additive and optional: contract v1 does not change. wlroots-bridge and kwin-portal-bridge implement it with the shared crate [`cu-overlay`](https://github.com/patrickjaja/cu-overlay) (wlr-layer-shell), which also documents the protocol in full.

- `doctor` advertises it with `capabilities.overlay: true` (wlroots-bridge adds `overlay_alpha_modifier` and `overlay_fractional_scale`). claude-desktop-extra starts the overlay only when this key is `true`, read from its cached `doctor` answer; a missing key means no overlay.
- `<bridge> overlay` is long-running: one JSON object per line on stdin and stdout, nothing else on stdout. Protocol 1, all coordinates global logical compositor coordinates (the space of `screens`):
  - stdout: `{"event":"ready","protocol":1,"backend","alphaModifier","fractionalScale","badge":false,"captureScopes":["all","cursor"],"outputs":[{name,x,y,width,height,scale}]}` once; `{"event":"outputs","outputs":[...]}` whenever the layout changes; `{"event":"shown","output","scale"}`; `{"event":"hidden"}`; `{"event":"ack","id"}`; `{"event":"error","message","fatal"}`.
  - stdin: `{"cmd":"show","output","look":"glow"|"rim","badge","reducedMotion","arrow":{x,y}|null}` (a show while shown updates in place or moves; an unknown output is fatal), `{"cmd":"move","output"}` (an unknown output is a non-fatal error), `{"cmd":"glide","frames":[[x,y,deg,lift],...],"frameMs"}` (frameMs 1..1000, default 16; up to 4096 frames), `{"cmd":"jump","x","y"}`, `{"cmd":"press","x","y"}`, `{"cmd":"look","look"}`, `{"cmd":"hide"}`, `{"cmd":"capture","phase":"hide"|"restore","id","scope":"all"|"cursor"}` (scope `all`, the default, makes everything transparent; `cursor` only the arrow and its press ring, the rim and glow stay; the overlay advertises the scopes it has in `ready.captureScopes`; each command is acked with its `id` once the compositor processed it; a hide restores itself after 3 s).
  - Exit codes: 0 on stdin EOF or the parent's death (`CLAUDE_CU_PARENT_PID`); 2 when it cannot run (no display, no layer-shell, an unknown output in `show`), after a fatal `error`; 1 when the compositor connection or stdout is lost.
- The surfaces are click-through (empty input region, no keyboard focus) and belong to the overlay process, so any exit removes them.
- kwin-portal-bridge only: it also draws a glow of its own in its screen-sharing session daemon. `doctor` `capabilities.session_overlay_opt_out: true` says that a `session-start` run with `KWIN_PORTAL_BRIDGE_SESSION_OVERLAY=0` in its environment starts no such glow (`set-overlay-display` stays a successful no-op then). claude-desktop-extra uses the overlay on KDE Plasma Wayland only when `doctor` reports both `overlay` and `session_overlay_opt_out`, decides it once per Computer Use lock before that lock's `session-start`, and then passes the variable to every `session-start` of the lock; with either key missing it passes nothing and the bridge's own glow stays (also with the glow switch on). With the glow switch off it passes the variable whenever `session_overlay_opt_out` is reported. The bridge sets KWin's `excludeFromCapture` on the overlay's surfaces, so they never appear in its screenshots; claude-desktop-extra sends no `capture` commands to it.
- claude-desktop-extra spawns it directly from the app's main process (no shell or wrapper), the process that also runs the bridge's screenshot commands: wlroots-bridge's screenshot mask looks through the overlay's layer only when the surface belongs to its parent or to a direct child of it. Around each screenshot or zoom (wlroots-bridge) it sends `capture` `hide` with scope `cursor` (only when `captureScopes` lists it; never a hide of everything), waits for the ack at most 50 ms, captures, then sends `restore`, also when the capture fails or is cancelled. One overlay per Computer Use lock, started at the first glow show of that lock: `hide` and a closed stdin at lock release, SIGTERM 1 s later, SIGKILL 1 s after that; one re-spawn per lock, then none until the next lock.

## Older bridges

A bridge whose `doctor` exits 2 or has no `contract` key is contract 0: consumers fall back to their per-bridge behaviour. A `forget-session` that exits 2 means the bridge cannot reset its grant; the launcher says so and tells the user to update.
