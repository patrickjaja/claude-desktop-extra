# Quick Entry

Setting up the hotkey, per desktop. For the short version, see [Quick Entry in the README](../README.md#quick-entry).

A global-hotkey popup (default `Ctrl+Alt+Space`) that opens a compact Claude prompt on the monitor where your cursor is.

## How the hotkey reaches the app

On Wayland the app registers its hotkey through the `xdg-desktop-portal` **GlobalShortcuts** interface. Whether that works depends on the portal backend your desktop runs:

| Desktop | Portal GlobalShortcuts | What to do |
|---------|------------------------|------------|
| KDE Plasma | yes | Nothing - the default hotkey works |
| Hyprland | yes, but Hyprland only fires it through a `global` bind | Add a bind (below) |
| GNOME 48+ | yes, after you approve the portal's prompt once | Approve it, or use `--install-gnome-hotkey` (below) |
| GNOME 47 and older | no | Run `--install-gnome-hotkey` once (below) |
| Sway, river, niri, other wlroots compositors | no (`xdg-desktop-portal-wlr` has no GlobalShortcuts) | Bind `claude-desktop --toggle` in the compositor config (below) |

Everywhere, the dependable route is a key bound in your desktop's own config to:

```bash
claude-desktop --toggle
```

It toggles Quick Entry in ~5-25 ms over a Unix domain socket and starts the app if it is not running (on a cold start the popup opens once the app has finished starting). For a [named profile](profiles.md), bind `claude-desktop --profile=NAME --toggle`.

## Per-desktop setup

**Sway** (`~/.config/sway/config`):

```text
bindsym Ctrl+Mod1+space exec claude-desktop --toggle
```

**river** (`~/.config/river/init`):

```bash
riverctl map normal Control+Alt Space spawn 'claude-desktop --toggle'
```

**niri** (`~/.config/niri/config.kdl`):

```kdl
binds {
    Ctrl+Alt+Space { spawn "claude-desktop" "--toggle"; }
}
```

**Hyprland** (`~/.config/hypr/hyprland.conf`) - either bind the CLI toggle:

```text
bind = CTRL ALT, space, exec, claude-desktop --toggle
```

or route a key to the shortcut the app registered through the portal. With the app running, `hyprctl globalshortcuts` lists it as `<app id>:<shortcut id>`; put that pair into a `global` bind:

```text
bind = CTRL ALT, space, global, <app id>:<shortcut id>
```

**GNOME** - bind the key directly via `gsettings`, bypassing the portal. Required on GNOME 47 and older, and the reliable choice on 48+ if you missed the portal prompt:

```bash
claude-desktop --install-gnome-hotkey                 # default Ctrl+Alt+Space
claude-desktop --install-gnome-hotkey '<Super>space'  # or any accelerator
claude-desktop --uninstall-gnome-hotkey               # remove it again
```

See [wayland.md](../wayland.md#quick-entry-hotkey-not-firing-on-gnome) for the details. `--install-gnome-hotkey` targets the default profile; for a named one, add a custom shortcut for `claude-desktop --profile=NAME --toggle` in GNOME Settings -> Keyboard.

**KDE Plasma** - nothing to do; the hotkey shows up under System Settings -> Shortcuts, where you can change it.

## Troubleshooting

Run `claude-desktop --diagnose`. Its GlobalShortcuts section probes the portal exactly the way the app does and says whether Wayland hotkeys are available; the **Problems found** list at the end names anything missing.

- **The hotkey stays dead for the whole session after login.** The app checks for the portal once, at startup, with a short timeout. If `xdg-desktop-portal` was still starting at that moment (common for autostart launches), Wayland hotkeys stay off until the app restarts. Quit and relaunch it, or use a compositor bind to `claude-desktop --toggle`, which never depends on the portal.
- **The app probes the portal with `busctl`** (part of systemd), at `/usr/bin/busctl` or, where that file does not exist (NixOS), on `PATH`. Without `busctl` it treats the portal as absent; `--diagnose` lists it under **Host capabilities**. A compositor bind to `claude-desktop --toggle` works either way.
