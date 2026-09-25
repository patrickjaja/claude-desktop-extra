# Troubleshooting

Logs, bug reports, common fixes and known limitations. For the short version, see [Troubleshooting in the README](../README.md#troubleshooting).

## Reporting a bug

Attach these two to the issue:

```bash
claude-desktop --diagnose
cat ~/.config/Claude/logs/claude-patches.log
```

In 3P mode the log is under `~/.config/Claude-3p/logs/`, for a named profile under `~/.config/Claude-<profile>/logs/` (3P: `~/.config/Claude-<profile>-3p/logs/`).

`--diagnose` prints the session type, portal and hotkey state, a **Host capabilities** section (each host tool the app runs, whether it is found, and what stops working without it), a **Computer Use** section (package version, a run check of every bundled bridge, and on KDE Wayland the KWin 6.6 check plus a portal-free self-test; window titles are never printed) and a closing **Problems found** list. Together with `claude-patches.log` this makes most reports diagnosable without follow-up questions.

## Logs

Runtime logs are in `~/.config/Claude/logs/` (`main.log`, `claude.ai-web.log`, `mcp.log`). While 3P mode is active (an `inferenceProvider` configured through the Deployment panel, `--3p`, or `/etc/claude-desktop/managed-settings.json`), logs and state are under `~/.config/Claude-3p/` instead; named profiles use `~/.config/Claude-<profile>/` (3P: `~/.config/Claude-<profile>-3p/`).

```bash
# Tail logs in real-time
tail -f ~/.config/Claude/logs/main.log

# Search for errors across all logs
grep -ri 'error\|exception\|fatal' ~/.config/Claude/logs/

# Launch with DevTools + full logging
CLAUDE_DEV_TOOLS=detach ELECTRON_ENABLE_LOGGING=1 claude-desktop 2>&1 | tee /tmp/claude-debug.log
```

**Clear stale Cowork sessions** (stuck "setting up workspace", or the model replaying old errors):

```bash
rm -rf ~/.config/Claude/local-agent-mode-sessions/
```

Computer Use emits `[claude-cu] diagnostics:` lines (detected session, available/missing tools, screenshot cascade) into `claude-patches.log`, and on stderr when launched from a terminal. The official build discards plain `console.log` output, so running from a terminal alone shows only Chromium noise - share the log file.

## App exits after a few seconds on native Wayland

On some systems (Nobara 43/KDE with AMD RDNA3, Fedora 44/GNOME with Intel Xe, both on kernel 7.0.x and Mesa 26.1 - [#180](https://github.com/patrickjaja/claude-desktop-extra/issues/180)) the GPU process repeatedly fails to launch under native Wayland and the app terminates itself:

```text
GPU process launch failed: error_code=1002
GPU process isn't usable. Goodbye.
```

The bug is upstream (Electron/Chromium) and intermittent. Try the mildest fix first and keep the first one that stays running:

```bash
CLAUDE_GPU_BACKEND=angle-gl claude-desktop                   # ANGLE OpenGL, keeps GPU acceleration
CLAUDE_DISABLE_GPU=1 claude-desktop                          # GPU compositing off
CLAUDE_DISABLE_GPU=full claude-desktop                       # GPU fully off
CLAUDE_USE_XWAYLAND=1 CLAUDE_DISABLE_GPU=full claude-desktop # + XWayland (confirmed working in #180)
```

**Persist it** (covers menu, autostart and `claude://` links; survives package updates):

```bash
cp /usr/share/applications/com.anthropic.Claude.desktop ~/.local/share/applications/
sed -i 's|^Exec=claude-desktop|Exec=env CLAUDE_USE_XWAYLAND=1 CLAUDE_DISABLE_GPU=full claude-desktop|' \
  ~/.local/share/applications/com.anthropic.Claude.desktop
```

Swap in whichever variables worked for you. Delete the file to return to defaults. All variables: [environment-variables.md](environment-variables.md).

## Global shortcut not working on KDE Plasma

Electron registers shortcuts via `kglobalaccel`. Stale entries from crashed or killed sessions block new registrations silently.

List registered Electron shortcuts:

```bash
gdbus call --session --dest org.kde.kglobalaccel \
  --object-path /component/electron \
  --method org.kde.kglobalaccel.Component.allShortcutInfos
```

Remove a stale one (`<action-id>` is the first field of the list output, e.g. `5DB35CB47F569991B62AF33B8F5CA3A0-Ctrl+Alt+Space`):

```bash
gdbus call --session --dest org.kde.kglobalaccel \
  --object-path /kglobalaccel \
  --method org.kde.KGlobalAccel.unregister \
  'electron' '<action-id>'
```

Remove all stale Electron shortcuts at once:

```bash
gdbus call --session --dest org.kde.kglobalaccel \
  --object-path /component/electron \
  --method org.kde.kglobalaccel.Component.allShortcutInfos 2>/dev/null \
| grep -oP "'[A-F0-9]+-[^']+'" | tr -d "'" | while read id; do
  gdbus call --session --dest org.kde.kglobalaccel \
    --object-path /kglobalaccel \
    --method org.kde.KGlobalAccel.unregister 'electron' "$id"
done
```

Then restart Claude Desktop; the portal prompts to approve the shortcut again. Hotkey setup for other desktops: [quick-entry.md](quick-entry.md).

## Known limitations

- **App identity on Wayland.** `xdg-desktop-portal` resolves unsandboxed apps via the systemd user scope. We launch under `app-com.anthropic.Claude-*.scope` and install the `.desktop` as `com.anthropic.Claude.desktop` - the same reverse-DNS identity the official build uses, and the value Chromium derives the window `app_id` / `WM_CLASS` from - so scope, `app_id`, `StartupWMClass` and `.desktop` basename all agree. KDE global shortcuts and persistent portal authorizations (screen share / Computer Use consent) attach to that id and survive across sessions.
  - Pinned taskbar/dock shortcuts from an earlier release (`claude-desktop.desktop` or older names) orphan on upgrade - **re-pin once**.
  - Custom X11/Wayland WM rules matching `claude-desktop` (or older `claude` / `com.anthropic.claude-desktop`) need updating to `com.anthropic.Claude`. The window `app_id` is the same for every profile; the window title carries the profile name.
  - KDE screen-share / Computer Use consent granted before the rename is keyed to the old id - re-grant once; it persists from then on.
  - GNOME shell-extension blacklists (Rounded Window Corners, Unite, Blur My Shell) referencing `com.anthropic.claude-quick-entry` should become `claude-quick-entry`.
  - **Sandboxes/containers** without a reachable user-systemd (bwrap, distrobox, restricted Flatpaks) auto-skip the scope wrap; force it with `--no-systemd-scope` / `CLAUDE_DISABLE_SYSTEMD_SCOPE=1` if the socket exists but is unreachable ([#89](https://github.com/patrickjaja/claude-desktop-extra/issues/89)).
- **Desktops without a tray host.** On a Wayland session where nothing provides a tray (`org.kde.StatusNotifierWatcher`: GNOME without the AppIndicator extension, sway or niri without a tray bar), closing the window quits the app instead of hiding it, and "Start at login" opens the window. The tray is detected once at startup.
- **Keep computer awake on tiling compositors.** Where no GNOME or freedesktop power-management service runs (Sway, Hyprland, niri, i3, ...), the setting holds a logind idle inhibitor. logind's IdleAction and hypridle honor it; plain `swayidle` timeouts do not.
- **Computer Use targets the primary monitor** - screenshots/clicks can be retargeted with `switch_display`; the teach overlay stays on the primary display. See [computer-use.md](computer-use.md).
- **CoworkSpaces are local-only** on every platform (no account-sync) - a set created on macOS/Windows won't transfer to Linux. Upstream behavior.
