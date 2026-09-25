# Command-line flags

Flags this project adds on top of the official build (run `claude-desktop --help` for the full list). All are optional; without any, `claude-desktop` just launches the default profile.

| Flag | Description |
|------|-------------|
| `--profile=NAME` | Launch (or target a subcommand at) a named [profile](profiles.md). Also selectable via a `claude-desktop-NAME` shortcut or `CLAUDE_PROFILE=NAME` |
| `--create-profile=NAME` | Create a [profile](profiles.md) (user-local binary, launcher, and menu entry; own login/logs/config) |
| `--delete-profile=NAME` | Remove a profile's entry points (user data preserved) |
| `--list-profiles` | List installed profiles |
| `--toggle` | Toggle the [Quick Entry](quick-entry.md) overlay (bind to a global shortcut) |
| `--reload-theme` | Ask the running instance to re-read its [theme](themes.md) files and re-apply the active theme; prints `{ok, changed, name, windows}`, exits 1 when the app is not running. Only needed with `"themeWatch": false`, the file watcher does it automatically otherwise |
| `--install-gnome-hotkey [ACCEL]` | Bind the Quick Entry hotkey on GNOME, where the portal doesn't (default `Ctrl+Alt+Space`); `--uninstall-gnome-hotkey` removes it |
| `--1p` / `--3p` | Select personal claude.ai (1P) vs [third-party inference](third-party-inference.md) (3P) mode by persisting the upstream `deploymentMode` key; replaces the removed upstream `--boot-1p-once` flag. The same switch is in the app under Settings → **Extra** → **Deployment**. See [switching back to 1P](third-party-inference.md#common-gotchas) |
| `--native-titlebar` | Use the native window frame instead of the integrated titlebar. Overrides the **Native titlebar** switch in Settings → **Extra** → **Community Features** for this launch |
| `--no-window-controls` | Drop the min/max/close buttons, which removes the thin frame Chromium paints around frameless windows on xfwm4, i3 and Awesome; window edges still resize, and you close or minimize through your WM. Overrides the **Hide window controls** switch in Settings → **Extra** → **Community Features** for this launch |
| `--no-systemd-scope` | Skip the `systemd --user --scope` wrapper for this launch (same as `CLAUDE_DISABLE_SYSTEMD_SCOPE=1`) |
| `--diagnose` | Print session type, portal status, hotkey state, and which host tools the app needs are missing (with what stops working), for issue reports. See [Reporting a bug](troubleshooting.md#reporting-a-bug) |
| `--integrate` / `--unintegrate` | Register / remove the `claude://` handler and menu entry (AppImage only; happens automatically on launch) |

Environment variables that tune the launch: [environment-variables.md](environment-variables.md).
