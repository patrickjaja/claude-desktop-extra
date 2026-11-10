# Multiple Profiles

How the profile system works, end to end. For the short version, see [Multiple Profiles in the README](../README.md#multiple-profiles).

Run several Claude Desktop instances side by side, each logged in to a different account, with fully isolated state for both Desktop and the Claude Code CLI it spawns. Useful for separating work from personal accounts, juggling SSO tenants, or testing config without touching your main install.

### Quick start

```bash
# One-time setup per profile
claude-desktop --create-profile=work
claude-desktop --create-profile=personal

# Launch (any of these work)
claude-desktop-work                     # via the per-profile shortcut
claude-desktop --profile=work           # via the system launcher
# …or click "Claude (work)" in your application menu

# Inspect / clean up
claude-desktop --list-profiles
claude-desktop --delete-profile=work    # removes entry points; user data preserved
```

The **default profile** (no `--profile=`, no named shortcut) is byte-identical to a single-instance install - same `~/.config/Claude`, same `~/.claude`, same sockets, same WM identity. You can run it alongside any number of named profiles.

A **named profile** (`--create-profile=NAME`, names match `[a-zA-Z0-9_-]+`, `default` reserved) installs three things in your home dir (no root needed): a per-profile Electron binary at `~/.local/lib/claude-desktop/claude-NAME`, a launcher symlink at `~/.local/bin/claude-desktop-NAME` (a small exec script on Nix, so it runs through the package wrapper), and an application-menu entry `Claude (NAME)`. User data is created lazily on first launch.

Three equivalent ways to select a profile at launch: `claude-desktop --profile=NAME`, `CLAUDE_PROFILE=NAME claude-desktop`, or the `claude-desktop-NAME` shortcut (infers the name from its basename). All export `CLAUDE_PROFILE`, which propagates through Electron and any spawned `claude` CLI.

### What's isolated

| Resource | Default profile | Named profile (e.g. `work`) |
|---|---|---|
| Electron userData (login, logs, settings, themes, Cowork sessions/Spaces, portal token) | `~/.config/Claude` | `~/.config/Claude-work` |
| Claude Code config (settings, projects, sessions, plugins) | `~/.claude` | `~/.claude-work` |
| Quick Entry toggle socket | `$XDG_RUNTIME_DIR/claude-desktop-qe.sock` | `…/claude-desktop-qe-work.sock` |
| systemd user scope (cgroup, portal identity) | `app-com.anthropic.Claude-PID.scope` | `app-com.anthropic.Claude-work-PID.scope` |
| WM_CLASS / Wayland app_id (taskbar grouping, Alt-Tab) | `com.anthropic.Claude` | `com.anthropic.Claude-work` when `com.anthropic.Claude-work.desktop` exists (written by `--create-profile`, or on the AppImage by its desktop integration when the profile starts with `--profile=NAME`), else `com.anthropic.Claude` |
| XDG autostart entry ("Start at login") | `~/.config/autostart/claude.desktop` | `…/claude-work.desktop` |

Plugins, MCP servers, login state, and chat history from one profile are **not** visible in another - profiles are independent installs, not shared views.

### Removing a profile

```bash
claude-desktop --delete-profile=work    # removes the three entry points
rm -rf ~/.config/Claude-work ~/.claude-work   # user data is preserved; delete manually for a clean slate
```

### SSO and URL routing

The `claude://` scheme is registered system-wide and points to the default profile's `.desktop` file. To route SSO callbacks to the profile that started them, claude-desktop-extra uses a marker mechanism ([`fix_profile_url_routing.nim`](../patches/core/fix_profile_url_routing.nim)): when a profile calls `shell.openExternal()` on an auth URL it writes a timestamped marker at `$XDG_RUNTIME_DIR/claude-desktop-pending-auth-<profile>`; when the launcher receives a `claude://` callback with no explicit profile it picks the most recent marker (< 5 min old) and re-execs as that profile.

Sequential SSO into any number of profiles is reliable. Two edge cases misroute (the "most recent marker wins" rule): clicking an unrelated outbound link mid-flow, or two SSO flows in flight concurrently - just re-attempt. The marker is `0600` and holds only a timestamp. Escape hatch: `claude-desktop --profile=NAME 'claude://<callback-url>'`.

**Opening shared-artifact links:** a `claude://cowork/shared-artifact?uuid=…` link opens Claude Desktop when clicked as a real hyperlink. Pasting it into a browser address bar won't work (the omnibox treats unknown schemes as a search - a browser security gate). To open a copied link: `xdg-open 'claude://cowork/shared-artifact?uuid=…'`.

### Notes

- **Disk cost.** A named profile gets its own copy of the Electron binary (a real file, not a symlink). The launcher tries hardlink → reflink (btrfs/xfs CoW) → plain copy in order, so only cross-filesystem installs on a non-CoW disk actually pay the ~200 MB; sibling files (`libffmpeg.so`, `.pak`, `locales/`, …) are always shared symlinks. Package upgrades that leave the copy stale are re-materialised automatically on the next launch (on Nix, from the tree `CLAUDE_ELECTRON` points at).
- **Window identity follows the profile's `.desktop` file.** A named profile's windows report `com.anthropic.Claude-NAME` as WM_CLASS / Wayland `app_id` when `com.anthropic.Claude-NAME.desktop` exists in an XDG applications directory (`--create-profile` writes it, with the matching `StartupWMClass`; on the AppImage its desktop integration writes it when the profile starts with `--profile=NAME`), so desktops that match windows to `.desktop` entries can show each profile as its own entry; the window title also carries the profile name (`Claude (work)`). Give the profile's `.desktop` its own `Icon=` to tell the entries apart at a glance. Window rules written for `com.anthropic.Claude` do not match a named profile's windows. Notifications are still attributed to the default app entry, and the `claude://` handler stays with the default profile. A profile without that `.desktop` file (`--profile=NAME` alone) keeps the shared `com.anthropic.Claude` identity; it isolates state the same way but adds no menu entry or shortcut, and the launcher prints a hint about it (silence with `CLAUDE_PROFILE_QUIET=1`). A profile whose only menu entry is an older `claude-desktop-NAME.desktop` also keeps the shared identity: `claude-desktop --delete-profile=NAME` removes the profile's entry points (the per-profile Electron copy, the `claude-desktop-NAME` launcher link and both `.desktop` names) and keeps its user data, and `claude-desktop --create-profile=NAME` then writes the current entry. A per-profile entry marked `Hidden=true` (as menu editors write when an entry is removed) counts as absent and also keeps the shared identity; deleting the per-profile `.desktop` file is the way to keep a profile grouped with the default. On KDE Plasma such a profile also registers its Quick Entry shortcut under its own entry in System Settings -> Shortcuts (`Claude (NAME)`): Plasma asks once to confirm it, and when two profiles bind the same key the one that registered first receives it, so give each profile its own key there.
- **AppImage:** `--create-profile` is not available (the AppImage's files move on every launch); run the AppImage with `--profile=NAME` instead. Its desktop integration then writes `com.anthropic.Claude-NAME.desktop`, so the profile gets its own menu entry and window identity.
- **[Quick Entry](quick-entry.md) hotkey is not per-profile** - `--install-gnome-hotkey` targets the default profile; for a named one, bind `claude-desktop --profile=NAME --toggle` by hand.
