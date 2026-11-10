# Escape stops Computer Use

Opt-in: Settings -> Extra -> Community Features -> **Escape stops Computer Use** (group *Computer Use*), or the same switch on the Extra -> Computer Use page (one setting, off by default; the `computerUseEscapeAbort` key in `claude-desktop-extra.jsonc` locks it). Press Escape anywhere to stop Computer Use while Claude is working, on the desktops listed below. The patch is [`add_feature_cu_escape_abort.nim`](../patches/community/add_feature_cu_escape_abort.nim); the watcher logic is [`js/cu_esc_watch.js`](../js/cu_esc_watch.js).

## Off (the default)

Anthropic's own handling, unchanged. On X11 it takes a global Escape grab while Claude is working: Escape stops Computer Use, and an Escape Claude itself sends can be swallowed by that grab. On Wayland there is no global stop key; only Escape in Claude's own window works. Nothing is spawned and nothing is cleaned up.

## On, per desktop

The switch applies live, from the next Computer Use task. Each desktop uses the `abort-watch` subcommand of the bundled bridge that serves it (see the [bridge contract](computer-use-bridge-contract.md#optional-abort-watcher-abort-watch)).

| Desktop | Mechanism | What Escape does while Claude is working |
|---|---|---|
| X11 | `x11-bridge abort-watch`: a passive XInput2 listener | Stops Computer Use and still reaches the focused app. If the watcher cannot run, Anthropic's own grab is used. |
| Hyprland | `wlroots-bridge abort-watch`: a non-consuming bind | Stops Computer Use and still reaches the app (verified on Hyprland 0.56.2). |
| sway | `wlroots-bridge abort-watch` | Stops Computer Use; Escape is taken while Claude is working. An existing Escape binding in sway's default mode keeps the stop key off. |
| KDE Plasma (Wayland) | `kwin-portal-bridge abort-watch`, through kglobalaccel | Escape only stops Computer Use: it does not close Overview, menus or the launcher, cancel a window move, or reach the app. Alt+Tab and the lock screen work as usual. Not enabled when another global shortcut already uses Escape. While armed, KDE records the component name (never a key) in `kglobalshortcutsrc`. |
| GNOME, niri, other compositors | not available | Use **Stop sharing** on the screen-share indicator (GNOME, KDE) or **Stop** in the app. |

The watcher runs only while Claude works: for the length of the Computer Use lock in the Code tab and local Cowork, per turn in cloud Cowork. Escape is never taken while Claude is idle.

The KDE stop key needs a runnable `kwin-portal-bridge` (glibc 2.39 or newer), so it is not available on Debian 12, Ubuntu 22.04, RHEL 9 and NixOS, where the bundled dynamic bridge does not run. On a Hyprland Lua config the bind is set through Hyprland's `eval`, which clears the config-error list Hyprland displays until the next config reload.

## Cleanup and failures


- At app start with the switch on, and after an abnormal watcher exit, a one-shot cleanup removes a stop key an earlier run left behind (a killed app cannot unbind its own).
- On X11, if the watcher cannot run (bridge missing or failing), Anthropic's own Escape grab is used instead.
- A refusal with a stated reason (another global shortcut already uses Escape on KDE, an Escape binding in sway's default mode, no kglobalaccel) is logged once and retried the next time Claude starts working; it does not turn the feature off. Three unexplained watcher failures in one app run do, until the app restarts or the switch is toggled; Computer Use itself is unaffected and Anthropic's own handling applies.
- Manual cleanup: if the app was killed hard while the stop key was armed and the switch was turned off before the next start, a compositor binding can stay. Run `<bridge> abort-watch </dev/null` to clear it, with `x11-bridge` (X11), `wlroots-bridge` (sway, Hyprland) or `kwin-portal-bridge` (KDE Plasma), from the `resources/` folder of the install (for example `/usr/lib/claude-desktop/resources/`).
- A watcher that cannot arm leaves nothing behind.

Log lines are `[claude-cu] esc-watch: ...` in `~/.config/Claude/logs/claude-patches.log`. `claude-desktop --diagnose` prints an `abortWatch` line per bridge.

## Stop sharing

Independent of this switch (always on): **Stop sharing** on the GNOME or KDE screen-share indicator stops the running Computer Use turn at once (log prefix `[claude-cu] stop-sharing:`). It also fires when the desktop itself ends the share (for example a portal restart, possibly a screen lock). Where `XDG_RUNTIME_DIR` is unset, the marker directory is watched only if it is a real directory owned by you without group or other write access.
