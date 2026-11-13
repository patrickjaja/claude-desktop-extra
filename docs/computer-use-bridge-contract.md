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
- `ax-find --window <id> [--role R] [--title-contains T] [--all] [--include-hidden] [--max-nodes N] [--max-depth N]` lists a window's elements (role, name, states, value, position) and returns an opaque `scope` plus a `ref` per element. `<id>` is an id from `windows`. The gnome bridge, whose window list carries no ids on stock GNOME, takes `--app-id <id> [--title <t>]` instead of (or with) `--window`. wlroots-bridge also takes `--expect-app-id <id>` and `--expect-title <t>` (what the caller listed for the window; a mismatch answers unavailable `window_changed`).
- `ax-action --scope <scope> --ref <ref> --action click|focus|set-text` acts on an element from `ax-find`. For `set-text` the text is read from stdin (whole, UTF-8, untrimmed) and never from argv.

Exit codes: a missing a11y bus, a screen reader, an unknown or ambiguous window, a stale element or an unsupported action is an **unavailable result** (a JSON object with an `unavailable` reason and a `hint`, exit 0), not an error. Bad usage, including invalid UTF-8 on the `set-text` stdin, exits 2. Other runtime errors exit 1.

`doctor` may add the optional key `atspi`: `{"bus": <bool>, "is_enabled": <bool>, "screen_reader": <bool>}`, plus `error` when the session bus is unreachable. It never activates the accessibility bus and never fails the command; on a hung bus it can take up to 5 seconds, so callers use a timeout above that.

The unavailable reasons of the four commands are `no_atspi_bus`, `no_tree_exposed`, `app_not_found`, `ambiguous_window` (with `candidates`: window titles of the matched app), `out_of_scope`, `stale_element`, `no_action` (with `candidates`: the element's action names, when it has some), `not_editable` and, wlroots-bridge only, `window_changed`. `screen_reader_active` is a `reason` of `ax-enable` / `ax-restore`. The additions below keep every one of them with its meaning.

### Accessibility feature negotiation (`ax-features`)

Everything in the rest of this section is additive inside contract v1 and gated by a feature name. A bridge with only the four baseline features behaves exactly as described above.

- `<bridge> ax-features` prints `{"ax_features": [<string>, ...]}` and exits 0. It opens no D-Bus connection, starts no session, reads no file and takes no flags. The list is static per build; order carries no meaning.
- A bridge without the subcommand exits 2 (clap usage error). The caller treats exit 2, and any other failure of the probe (exit 1, timeout, output that is not this shape), as the empty list. An empty list means: only the baseline commands and flags above, used exactly as today.
- `doctor.atspi.features` carries the same list (also when `doctor.atspi` reports `error`). `ax-features` is authoritative; `doctor` is for diagnostics. A caller may cache the list per bridge binary path for the life of its process.
- **Rule:** the caller never passes a flag, an `--action` value or a stdin shape whose feature is not in the list, and never relies on an output field whose feature is not in the list. The caller ignores feature names it does not know. A feature name never changes meaning; a changed shape gets a new name.

```json
{"ax_features":["find.v1","action.click","action.focus","action.set_text","find.identity","action.expect","find.window_ref","find.deadline","find.root","find.skeleton","action.ensure","action.scroll_to","action.set_value"]}
```

| feature | gates |
|---|---|
| `find.v1` | `ax-find` with the baseline flags above (including gnome `--app-id` / `--title` and wlroots `--expect-app-id` / `--expect-title`) and the baseline output |
| `action.click` | `ax-action --action click` |
| `action.focus` | `ax-action --action focus` |
| `action.set_text` | `ax-action --action set-text`, text on stdin |
| `find.identity` | element fields `accessible_id`, `depth`, `parent_index`, `path`, `unique` in every `ax-find` result |
| `action.expect` | `ax-action --expect-json` (stdin JSON object); `delivery` on every `ax-action` output, result or unavailable; reason `element_changed`. Listed only together with `find.identity` |
| `find.window_ref` | `ax-find --window-ref <ref>`; result key `window_ref_used` |
| `find.deadline` | `ax-find --deadline-ms <n>` |
| `find.root` | `ax-find --root-ref <ref> --scope <scope>`; result key `root_ref` |
| `find.skeleton` | `ax-find --skeleton`; element field `child_count` |
| `action.ensure` | `--action` `ensure-checked`, `ensure-unchecked`, `ensure-expanded`, `ensure-collapsed`, `ensure-selected`; result key `already`; `post.expanded`, `post.selected`; reasons `unsupported_action`, `requires_input` |
| `action.scroll_to` | `--action scroll-to`; reason `unsupported_action` |
| `action.set_value` | `--action set-value` (number in the `--expect-json` object); reasons `unsupported_action`, `value_out_of_range` |

`action.ensure`, `action.scroll_to` and `action.set_value` are listed only together with `action.expect`.

### `ax-find` additions

**`find.identity`: element fields.** Every element carries all five keys:

| key | type | meaning |
|---|---|---|
| `accessible_id` | string or null | AT-SPI `Accessible.AccessibleId` (the toolkit's developer id). null when the property is missing or empty, and for elements whose `name` is blanked by terminal taint (see Redaction) |
| `depth` | number | levels below the walk root: a direct child of the window frame is 1 |
| `parent_index` | number or null | the `index` of the nearest ancestor that is also in this `elements` list; null when no ancestor is listed (the walk root is never listed) |
| `path` | array of numbers | child positions from the walk root down to the element, one per level (`path.length == depth`), each the element's position among its parent's children as the walk read them. A hint for layout and diagnostics only, never identity: a sibling inserted above shifts it |
| `unique` | bool or null | no other walked node has the same `role`, `name` and `accessible_id` (each compared exactly as printed, after redaction). Counted over every node the walk read, listed or not, including nodes the visibility clip dropped; non-`showing` subtrees count only with `--include-hidden`. null when the result is `truncated` (any `truncated_reason`) or the walk was rooted with `--root-ref`, because then the rest of the window was not seen, and when any walked node or child list could not be read completely (a node's facts or `ChildCount` unreadable, a failed indexed child read, a `GetChildren` reply shorter than `ChildCount`, a null child ref, a child on another bus than the walk root, which the walk does not enter), because a twin may have been missed |

`index` keeps its meaning (BFS visit order, walk root = 0).

`name`, `description` and `accessible_id` are capped at 4 KiB each when read (cut on a character boundary, `...` appended), before `unique` is counted and before the `--expect-json` comparison, so a capped value printed by `ax-find` compares equal in a later `ax-action`.

**`find.window_ref`: `--window-ref <ref>`.** `<ref>` is the `window.ref` of an earlier `ax-find` of the same window. The bridge matches the app exactly as without the flag (pid, then app id / WM_CLASS) and then uses `<ref>` as the window instead of its own title-based window choice when, and only when, `<ref>` is on that app's bus, its parent is that app's root, it is not `defunct` and it is `showing`. Otherwise the flag is ignored and the window is resolved as without it (which may answer `app_not_found` or `ambiguous_window`). Every other check is unchanged: the app match, the result's `app.pid` and `matched_by` (and the caller's own pid and `matched_by` checks), the frame classification against the bridge's window rect. The result adds `window_ref_used` (bool, present only when the flag was passed). **Geometry with `--window-ref`.** The bridge's window rect describes the window `--window` resolved to, which the ref may not be. When the ref is used, the bridge supplied a window title and a rect, and the ref window's current accessible title is not that title (compared with whitespace runs collapsed, dashes folded and case ignored), the result carries no screen geometry derived from the bridge's rect: `coords: "window_only"`, `frame_class: "unknown"`, no `window.rect_screen` and no element `rect_screen` (`rect_window` stays). The one exception is X11, when the ref window's global extents match the bridge's window or client rect within 2 px (then it is the same window). A bridge that supplied no rect is unaffected.

wlroots-bridge: when `window_ref_used` is true, a title that differs from `--expect-title` is not `window_changed` as long as the app id matches `--expect-app-id` and the result's `window.title` (the ref window's current accessible title) equals the current title of the toplevel `--window` resolved to (same comparison as above). That accepts "the title changed since the caller listed it" and refuses "this id now names another window of the app"; refused, the answer is `window_changed` with no element data. Without `--expect-app-id` the title check applies as before. gnome-portal-bridge: when `window_ref_used` is true, `--title` does not have to match.

**`find.deadline`: `--deadline-ms <n>`.** Shortens one find for polling. `n` is clamped to 100..=5000. The walk stops `n` ms after the command started (instead of after 5 s) and the whole command ends within `n + 2000` ms (instead of 10 s); the remaining time is for the detail reads. A walk stopped by it answers `truncated: true`, `truncated_reason: "deadline"` with what it read so far (and `unique: null`). Exceeding the whole-command limit is a runtime error (exit 1), as the 10 s limit is today. Callers use a process timeout above `n + 2000`.

**`find.root`: `--root-ref <ref> --scope <scope>`** (each requires the other; passing only one exits 2; a `<ref>` or `<scope>` string that does not parse is a runtime error, exit 1, as in `ax-action`). Walks only below one element of the window. `<scope>` is the `scope` of an earlier `ax-find` of this window, `<ref>` an element `ref` of that result. The window arguments (`--window`, gnome `--app-id` / `--title`) are still required and are resolved as always; then:

1. the resolved window must be the window `<scope>` names (same unique bus, same window path, same app pid), else unavailable `out_of_scope`;
2. `<ref>` gets the same checks `ax-action` applies before acting: same bus, unchanged peer pid, not gone or `defunct` (else `stale_element`), a Parent chain of at most 64 steps that reaches the scoped window (else `out_of_scope`).

The walk then starts at `<ref>` (`index` 0, `depth` 0, `path` [], never listed itself) with the usual budgets and filters. Its elements are clipped only by the window frame, not by scroll containers above the root. Taint is inherited from the root's ancestors exactly as `ax-action` computes it (see Redaction), so redaction is the same as in a whole-window walk. `scope` and `window` in the result are those of the window; the result adds `root_ref` (the `<ref>` walked). A rooted walk never answers `no_tree_exposed` (an empty list is a valid answer). `unique` is always null.

**`find.skeleton`: `--skeleton`.** Lists containers only: every walked node with at least one child, whatever its role, instead of the interactive filter. It conflicts with `--role`, `--title-contains` and `--all` (exit 2). Every element of a skeleton result carries `child_count` (number, the AT-SPI `ChildCount`; the walk may have read fewer). Combines with `--root-ref`, `--max-depth` and `--max-nodes`. `child_count` is absent without `--skeleton`.

Budgets are unchanged by every addition: `--max-nodes` default 300, clamped to 1..=2000; `--max-depth` default 32, clamped to 1..=64; without `--deadline-ms` a 5 s walk and a 10 s command.

An element with `find.identity` (bridge-specific `rect_*` keys as before):

```json
{"index": 7, "ref": ":1.42/org/a11y/atspi/accessible/12", "role": "check box", "ax_role": "AXCheckBox",
 "name": "Word wrap", "states": ["checked"], "actions": ["click"],
 "accessible_id": "wrap-toggle", "depth": 3, "parent_index": 4, "path": [0, 2, 1], "unique": true,
 "rect_window": {"x": 12, "y": 80, "width": 120, "height": 24}}
```

### `ax-action` additions

**`action.expect`: `--expect-json`.** With the flag, stdin is exactly one UTF-8 JSON object (whitespace around it allowed) and nothing else; it replaces the raw `set-text` stdin. Without the flag, stdin is handled exactly as today (`set-text` reads the raw text, other actions ignore stdin).

```json
{"expect": {"role": "check box", "name": "Word wrap", "accessible_id": "wrap-toggle"}, "text": "only for set-text", "value": 42.5}
```

- `expect` is required, with all three keys: `role` (string, the AT-SPI `role` as `ax-find` printed it), `name` (string, as printed; `""` for none), `accessible_id` (string or null, as printed).
- `text` (string) is required for `set-text` and not allowed for any other action. `value` (finite number) is required for `set-value` and not allowed for any other action.
- An unknown key, a missing required key, a wrong type, invalid UTF-8 or JSON, or trailing data exits 2 before any D-Bus call. The bridge never echoes or logs `text`, `value` or `expect`.
- The bridge reads at most 16 MiB of stdin, with or without `--expect-json` (raw `set-text` text too); larger input is a runtime error (exit 1), nothing sent.
- The check runs after the existing checks (same bus, unchanged pid, not gone or `defunct`, Parent chain into the scoped window) and before anything is planned or sent. The bridge reads the element's role, name and accessible id, applies the same taint as `ax-find` (a descendant of a terminal compares as `name: ""` and `accessible_id: null`), and compares each key exactly. Any difference answers unavailable `element_changed`, `delivery: "not_sent"`.

`--action set-value` requires `--expect-json` (exit 2 without). The caller sends `--expect-json` on every action once `action.expect` is listed.

**New `--action` values.** Result `action` names are the snake_case form (`ensure_checked`, ..., `scroll_to`, `set_value`), like `set_text` today.

| `--action` | feature | goal | how |
|---|---|---|---|
| `ensure-checked` / `ensure-unchecked` | `action.ensure` | `ensure-checked`: `checked` set and `indeterminate` not set. `ensure-unchecked`: `checked` not set, `indeterminate` or not; a box that is `checked` + `indeterminate` is acted on | the element must be checkable (`checkable` state or a check box, radio button, toggle button, check or radio menu item role). One `DoAction` (method `action:<name>`): `check` for `ensure-checked`, `uncheck` for `ensure-unchecked` (never the opposite one), else a click-like action. `ensure-unchecked` on a checked radio button or radio menu item is `unsupported_action` |
| `ensure-expanded` / `ensure-collapsed` | `action.ensure` | `expanded` state set / `collapsed` (or no `expanded`) | the element must be `expandable` or report `expanded` / `collapsed`. An `expand` / `collapse` action, GTK 3's `expand or contract`, `open` / `close` (not on rows, cells, list items or tree items) or `toggle` (not on a checkable element other than a toggle button, where it would flip the check box); else `click`, `press` or `ShowMenu` on a combo box, push button, toggle button, menu or menu item (`activate` too on a push or toggle button: GTK 3's expander has only that). Rows, cells, list items and tree items never fall back to `activate`, `jump`, `open` or any other name: `unsupported_action`. Method `action:<name>` |
| `ensure-selected` | `action.ensure` | `selected` state set | the element must be `selectable`. `Selection.SelectChild` on the parent when the parent has the Selection interface (method `select_child`; the bridge first confirms that the parent's child at the element's index is still this element, else `stale_element`, `delivery: "not_sent"`), else a `select` action, else the button fallback of `ensure-expanded` (never on rows, cells or items) |
| `scroll-to` | `action.scroll_to` | the element scrolled into view | `Component.ScrollTo` with `ANYWHERE` (method `scroll_to`). Always sent, also when already in view |
| `set-value` | `action.set_value` | `Value.CurrentValue` = the requested `value` | the element must have the Value interface and not be `read_only`. A requested value below `MinimumValue` or above `MaximumValue` is refused with `value_out_of_range`, never clamped (a clamped value is not what the caller asked for; the caller can choose an in-range value). When the element reports `MinimumValue >= MaximumValue` the range is unknown and the value is sent as is. Method `set_current_value` |

- **Action names** are compared case-insensitively. A goal-aware name (`check`, `uncheck`, `select`, `expand` / `open`, `collapse` / `close`, as Chromium and Firefox name them) is preferred over a generic one.
- **Idempotent ensure.** The bridge reads the current state first. Already in the goal state: nothing is sent, the result is `{"ok": true, "already": true, "method": "none", "delivery": "not_sent", "post": {...}}`. Every ensure result carries `already` (bool); other actions never do.
- **Planner refusals.** No supported way to reach the goal (wrong kind of element, no fitting action or interface): unavailable `unsupported_action`, nothing sent. A Qt combo box whose popup is a native window on a Wayland session (`ensure-expanded` / `ensure-collapsed` on a Qt `combo box` outside X11): unavailable `requires_input`, nothing sent; the caller falls back to pointer input. The "already in the goal state" check runs before `requires_input`, so such a combo box that is already collapsed answers `already: true`. `click` keeps its baseline behavior on every element.
- **`set-value` range.** When `MinimumValue` or `MaximumValue` cannot be read, the value is sent and the read-back decides.
- **Reply.** A D-Bus error reply to the `ensure-*`, `scroll-to` or `set-value` call while the element still exists (an app without `ScrollTo`, a refused write) is `ok: false`, `delivery: "sent"`, with a generic `error` text (never the app's message or a value). An error reply after which the element is gone is `stale_element`, `delivery: "sent_unverified"`. No reply in time (including the connection's own 2 s method timeout), a transport error or a reply of an unexpected type is `ok: null`, `method: "dispatched"`, `delivery: "sent_unverified"`, and `post` is omitted.
- **Read-back.** After a sent `ensure-*` or `set-value` that got a reply, the bridge reads the state back, polling for up to 1.5 s (GTK 3 runs actions from an idle handler, after the reply). The goal is verified when the read-back shows it; for `set-value` when `|read - requested| <= max(MinimumIncrement / 2, 1e-9 * max(1, |requested|))`. Verified: `ok: true`, `delivery: "sent"`. The toolkit answered but the read-back does not show the goal or could not be read: `ok: null`, `delivery: "sent_unverified"`, the real `method`, and `error` saying what the read-back showed (never a value of a redacted or terminal element). The verification read is internal; Redaction governs only what is printed.

**`post` additions.** `post` keeps `focused`, `checked` (the raw `checked` bit, also when `indeterminate` is set), `value` (string, the same preview `ax-find` prints; for a Value-interface element the number as a decimal string) and `value_redacted`, and gains `expanded` (bool, present when the element is `expandable` or reports `expanded` / `collapsed`) and `selected` (bool, present when the element is `selectable`). Both come with `action.ensure` and appear on the `post` of every action of such a bridge.

### Delivery (`action.expect`)

Every `ax-action` output of a bridge that lists `action.expect` carries `delivery`, with or without `--expect-json`, on results and on unavailable answers:

| `delivery` | meaning |
|---|---|
| `not_sent` | no call that can change the app was made (`DoAction`, `GrabFocus`, `SetTextContents`, `DeleteText`, `InsertText`, `SelectChild`, `ScrollTo`, a `CurrentValue` write). Safe to retry |
| `sent_unverified` | such a call was made, and the bridge cannot tell whether the app carried it out: no reply in time, the element disappeared during or after the call, or (`ensure-*`, `set-value`) the read-back does not confirm the goal. Do not repeat blindly |
| `sent` | such a call was made and the toolkit replied; for `ensure-*` and `set-value` the read-back also confirms the goal. The reply may still be a refusal (`ok: false`) |

Relation to `ok`:

- `ok: true` comes with `sent`, or with `not_sent` when `already` is true.
- `ok: false` (the toolkit answered false, `set_text` failed and was rolled back, or an `ensure-*` / `scroll-to` / `set-value` call got a D-Bus error reply while the element still exists) comes with `sent`.
- `ok: null` comes with `sent_unverified`: `method: "dispatched"` when no reply came in time (as today), the real method when an `ensure-*` / `set-value` read-back did not confirm.
- Every unavailable answer of `ax-action` comes with `not_sent`, except `stale_element` raised because the element vanished after a call was made, which comes with `sent_unverified`.
- Exit 2 means nothing was sent. Exit 1 (runtime error, including the 8 s command limit) carries no JSON; the caller treats it as `sent_unverified`.

A caller talking to a bridge without `action.expect` derives it: unavailable `stale_element` -> `sent_unverified`, any other unavailable -> `not_sent`, `ok: null` -> `sent_unverified`, otherwise `sent`.

### New unavailable reasons

| reason | command | meaning | `delivery` |
|---|---|---|---|
| `element_changed` | `ax-action` | the element at the ref no longer has the `role`, `name` or `accessible_id` of `--expect-json` | `not_sent` |
| `unsupported_action` | `ax-action` | `ensure-*`, `scroll-to` or `set-value` has no supported way on this element | `not_sent` |
| `requires_input` | `ax-action` | the goal needs pointer or keyboard input (Qt native combo popup on Wayland) | `not_sent` |
| `value_out_of_range` | `ax-action` | the `set-value` value lies outside the element's range; adds `range: {"min": <number>, "max": <number>}` | `not_sent` |

`--root-ref` reuses `out_of_scope` and `stale_element` on `ax-find`. All of them carry `hint`.

```json
{"ok": true, "action": "ensure_checked", "method": "action:toggle", "already": false, "delivery": "sent", "post": {"focused": false, "checked": true}}
{"unavailable": "element_changed", "hint": "The element at this ref is no longer the one that was listed; list the window again.", "delivery": "not_sent"}
```

### Redaction

The redaction rules of `ax-find` cover every new field and command. `ax-action` (the `--expect-json` comparison and `post`) and a `--root-ref` walk take the taint an element inherits from its ancestors up to the window with the walk's own rule: a `password text` or `terminal` ancestor, or an editable field labelled like a secret (name or description), taints its descendants, and the outermost one wins. A Parent or facts read that fails on the way up before the window is reached counts as the strictest taint (terminal), never as none. A `password text` element, an editable field labelled like a secret, and every descendant of one never expose a value: no `value` in `ax-find`, no `post.value` after any action (`set-text`, `set-value` and `ensure-*` included), `value_redacted: true` instead. A `terminal` element exposes its name only (no value); its descendants expose no value, `name` as `""` and `accessible_id` as null, in `ax-find`, in the `--expect-json` comparison and in `unique`. `error` texts never quote a value, and the text, value and expectation from stdin are never echoed or logged.

## Optional: abort watcher (`abort-watch`)

x11-bridge, wlroots-bridge and kwin-portal-bridge add a long-running `abort-watch` subcommand that reports the user's physical Escape press, for the opt-in [Escape stops Computer Use](cu-escape-abort.md) switch. Additive and optional: the app starts it without asking `doctor` first, and a bridge without it answers with a usage error, which the app treats as "cannot arm". The implementation is the shared crate [`cu-abort-watch`](https://github.com/patrickjaja/cu-abort-watch), which also documents the protocol in full.

- stdout, one JSON object per line: `{"event":"ready","mechanism":"xi2|sway|hyprland|kglobalaccel","syntheticSafe":<bool>}` once armed, `{"event":"abort"}` per press, `{"event":"ack","cmd":"suspend"|"resume"}`, `{"event":"error","message":...}`. `syntheticSafe: true` means an Escape the model injects can never produce an `abort`.
- stdin, one command per line: `suspend` (stop reporting and consuming Escape) and `resume`.
- Exit codes: 0 on stdin EOF, SIGTERM/SIGINT/SIGHUP or the parent's death (`CLAUDE_CU_PARENT_PID` names the process to watch); 1 on a runtime failure after an `error` line; 2 when arming failed, after an `error` line, with nothing left behind.
- Nothing is left bound on exit; binds shared by several profiles are healed by the next first holder.
- `doctor.abortWatch` says whether and how this bridge can watch on the current session.

## Optional: glow overlay (`overlay`)

A bridge may draw Claude's "Claude is using your computer" glow and drawn cursor on its compositor. Additive and optional: contract v1 does not change. wlroots-bridge, kwin-portal-bridge and gnome-portal-bridge implement it with the shared crate [`cu-overlay`](https://github.com/patrickjaja/cu-overlay), which also documents the protocol in full: wlroots-bridge and kwin-portal-bridge with its wlr-layer-shell backend, gnome-portal-bridge with its x11 backend (click-through override-redirect XWayland windows, since Mutter has no layer-shell; `ready.backend` is `"x11"`).

- `doctor` advertises it with `capabilities.overlay: true` (wlroots-bridge and gnome-portal-bridge add `overlay_alpha_modifier` and `overlay_fractional_scale`; kwin-portal-bridge adds those and `session_overlay_opt_out`). claude-desktop-extra starts the overlay only when `overlay` is `true`, read from its cached `doctor` answer; a missing key means no overlay.
- `<bridge> overlay` is long-running: one JSON object per line on stdin and stdout, nothing else on stdout. Protocol 1, all coordinates global logical compositor coordinates (the space of `screens`):
  - stdout: `{"event":"ready","protocol":1,"backend","alphaModifier","fractionalScale","badge":true|false,"captureScopes":["all","cursor"],"outputs":[{name,x,y,width,height,scale}]}` once; `{"event":"outputs","outputs":[...]}` whenever the layout changes; `{"event":"shown","output","scale"}`; `{"event":"hidden"}`; `{"event":"ack","id"}`; `{"event":"error","message","fatal"}`.
  - stdin: `{"cmd":"show","output","look":"glow"|"rim","badge","badgeText","reducedMotion","arrow":{x,y}|null}` (a show while shown updates in place or moves; an unknown output is fatal; `badge: true` flashes the "Claude is using your computer" pill for 6 s, centred then sliding to the top-right corner, never under `reducedMotion`, with `badgeText` optionally replacing its text; every show with `badge: true` restarts the flash and a show without it clears a running one, so the client sends it once per run, on the show that starts it, and only when `ready.badge` is `true`; the client captures with scope `all` while the badge is up), `{"cmd":"move","output"}` (an unknown output is a non-fatal error), `{"cmd":"glide","frames":[[x,y,deg,lift],...],"frameMs"}` (frameMs 1..1000, default 16; up to 4096 frames), `{"cmd":"jump","x","y"}`, `{"cmd":"press","x","y"}`, `{"cmd":"look","look"}`, `{"cmd":"hide"}`, `{"cmd":"capture","phase":"hide"|"restore","id","scope":"all"|"cursor"}` (scope `all`, the default, makes everything transparent; `cursor` only the arrow and its press ring, the rim, glow and badge stay; the overlay advertises the scopes it has in `ready.captureScopes`; each command is acked with its `id` once the compositor processed it; a hide restores itself after 3 s).
  - Exit codes: 0 on stdin EOF or the parent's death (`CLAUDE_CU_PARENT_PID`); 2 when it cannot run (no display, no layer-shell and no XWayland with a compositing manager, an unknown output in `show`), after a fatal `error`; 1 when the compositor connection or stdout is lost.
  - On the x11 backend, `ready.outputs[].scale` is the X drawing factor (1 without Mutter's `xwayland-native-scaling`), not the monitor's scale; the outputs' names are the connector names `screens` reports and their geometry is the layout space of `screens`. A `capture` hide is acked 50-64 ms after it (the opacity change, an X round trip and 50 ms for Mutter to repaint); a restore at once. The glow is static unless the overlay's environment sets `CU_OVERLAY_X11_PULSE_MS`.
- The surfaces are click-through (empty input region, no keyboard focus) and belong to the overlay process, so any exit removes them.
- kwin-portal-bridge only: it also draws a glow of its own in its screen-sharing session daemon. `doctor` `capabilities.session_overlay_opt_out: true` says that a `session-start` run with `KWIN_PORTAL_BRIDGE_SESSION_OVERLAY=0` in its environment starts no such glow (`set-overlay-display` stays a successful no-op then). claude-desktop-extra uses the overlay on KDE Plasma Wayland only when `doctor` reports both `overlay` and `session_overlay_opt_out`, decides it once per Computer Use lock before that lock's `session-start`, and then passes the variable to every `session-start` of the lock; with either key missing it passes nothing and the bridge's own glow stays (also with the glow switch on). With the glow switch off it passes the variable whenever `session_overlay_opt_out` is reported. The bridge sets KWin's `excludeFromCapture` on the overlay's surfaces, so they never appear in its screenshots; claude-desktop-extra sends no `capture` commands to it.
- claude-desktop-extra spawns it directly from the app's main process (no shell or wrapper), the process that also runs the bridge's screenshot commands: wlroots-bridge's screenshot mask looks through the overlay's layer only when the surface belongs to its parent or to a direct child of it. Around each screenshot or zoom (wlroots-bridge) it sends `capture` `hide` with scope `cursor` when the rim shows an arrow (only when `captureScopes` lists it; scope `all` while the badge is up, otherwise never a hide of everything), waits for the ack at most 50 ms, captures, then sends `restore`, also when the capture fails or is cancelled. gnome-portal-bridge (`ready.backend` `"x11"`): an XWayland window is in every ScreenCast frame and nothing excludes it, so every zoom gets a `hide` with scope `all` (glow, rim, arrow, ring and badge, whatever the look), the ack is awaited at most 150 ms, and a capture still running after 2 s gets the `hide` again (it restarts the overlay's 3 s self-restore) until the `restore`. One overlay per Computer Use lock, started at the first glow show of that lock: `hide` and a closed stdin at lock release, SIGTERM 1 s later, SIGKILL 1 s after that; one re-spawn per lock, then none until the next lock.

## Older bridges

A bridge whose `doctor` exits 2 or has no `contract` key is contract 0: consumers fall back to their per-bridge behaviour. A `forget-session` that exits 2 means the bridge cannot reset its grant; the launcher says so and tells the user to update.
