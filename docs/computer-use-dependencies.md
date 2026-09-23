# Computer Use dependencies

[Computer Use](../README.md#computer-use) auto-detects your session at runtime and routes to a **bundled first-party bridge**. Before it selects a bridge, the app runs it once (`--version`, 3 s timeout) and only uses it if it answers; a bridge that is present but cannot run on this system falls through to the next tier, and `claude-patches.log` names the cause (PipeWire or glibc too old, a foreign ELF loader on NixOS, wrong CPU architecture).

| Session (`echo $XDG_SESSION_TYPE` / `$XDG_CURRENT_DESKTOP`) | Bundled backend | Packages to install |
|--------------------------------------------------------------|-----------------|---------------------|
| X11 / XWayland (any DE) | [`x11-bridge`](https://github.com/patrickjaja/x11-bridge) | *none* |
| Wayland - Sway / Hyprland / Niri | [`wlroots-bridge`](https://github.com/patrickjaja/wlroots-bridge) | *none* |
| Wayland - GNOME (PipeWire >= 1.0.5: Ubuntu 24.04+, Fedora 40+, Debian 13+) | [`gnome-portal-bridge`](https://github.com/patrickjaja/gnome-bridge) | *none* |
| Wayland - KDE Plasma 6.6+ | [`kwin-portal-bridge`](https://github.com/patrickjaja/kwin-portal-bridge) | *none* |
| Wayland - KDE Plasma before 6.6, or a `kwin-portal-bridge` that cannot run | - (fallback) | `spectacle` (+ `imagemagick`); input via `ydotool` v1.0+ or x11-bridge over XWayland |
| Wayland - other compositors | - (fallback) | `ydotool` v1.0+ (+ running `ydotoold`) |

**How each bridge works:**

- **`x11-bridge`** (X11 / XWayland): XTest input, GetImage screenshots, EWMH window activation. Fully static Rust binary - no glibc floor, runs on every distro including NixOS. Replaced the old `xdotool` / `scrot` / `imagemagick` / `wmctrl` X11 cascade.
- **`wlroots-bridge`** (Sway / Hyprland / Niri): native Wayland protocols - virtual-pointer + virtual-keyboard for input, wlr-screencopy for screenshots, foreign-toplevel for window listing/activation. Fully static, no daemon, no permission dialogs. Replaced `ydotool` + `grim` + `hyprctl`/`swaymsg`+`jq`/`niri`.
- **`gnome-portal-bridge`** (GNOME Wayland): XDG RemoteDesktop + ScreenCast portal with PipeWire capture. Shows **one system consent dialog** ("remote control") per Computer Use session; on **GNOME 46+** the grant is persisted via restore token and never asked again. Replaced `ydotool` + the `gnome-screenshot` / `gdbus` / python-GStreamer portal cascade. **Runtime floor: PipeWire >= 1.0.5 and glibc 2.39** (Ubuntu 24.04+, Fedora 40+, Debian 13+) - the pipewire client library it links calls APIs that older distros lack, so on Ubuntu 22.04, Debian 12, and RHEL 9 GNOME Wayland the bundled bridge does not load (use X11/XWayland there, or set `GNOME_PORTAL_BRIDGE_BIN` to a locally built binary). Set flat mouse accel for accurate clicks: `gsettings set org.gnome.desktop.peripherals.mouse accel-profile flat`.
- **`kwin-portal-bridge`** (KDE Plasma 6.6+): XDG portals + KWin scripting - input, screenshots, clipboard, window control. One consent prompt per session. Pre-6.6 KDE falls back to `spectacle` (+ `imagemagick` for cropping) and `ydotool`/x11-bridge-over-XWayland.

> <a id="custom-screenshot-command"></a>
> **Custom screenshot command:** set `COWORK_SCREENSHOT_CMD` to override auto-detection. Placeholders: `{FILE}`, `{X}`, `{Y}`, `{W}`, `{H}`. Example: `COWORK_SCREENSHOT_CMD='spectacle -b -n -r -o {FILE}'`

<a id="bridge-not-working"></a>
## When the bundled bridge cannot talk to your session

On a covered session the bridge is the only backend - there is deliberately no
third-party cascade behind it, and no X11 fallback either (under a rootless
XWayland server the X root window holds nothing, so an X11 screenshot there can
only answer `BadMatch`). If the bridge stops answering, Computer Use fails
instead of quietly returning a black or mis-cropped image.

It fails **fast**: a failed portal session is remembered for 60 seconds, so
input and capture return an error immediately rather than blocking on the bridge
again. The screenshot path never blocks the app at all.

To find out why, run the diagnostics:

```bash
claude-desktop --diagnose        # the "Computer Use" section self-tests the bridge
grep -a 'claude-cu' ~/.config/Claude/logs/claude-patches.log
```

On GNOME Wayland `--diagnose` runs the bridge's portal-free `gnome-portal-bridge
screens` call with a timer. If that reports `FAILED` (or `exit 124` = timed out),
capture cannot work until it succeeds - the bridge is not reaching Mutter.
`COWORK_SCREENSHOT_CMD` overrides the screenshot path in the meantime.

<a id="ydotool-setup"></a>
## ydotool (exotic Wayland compositors only)

`ydotool` is only needed on Wayland compositors that are **not** wlroots-based, GNOME, or KDE (e.g. COSMIC, Enlightenment). Those sessions fall back to `ydotool` v1.0+ with a running `ydotoold` daemon:

```bash
sudo pacman -S ydotool && sudo systemctl enable --now ydotool   # Arch
sudo dnf install ydotool && sudo systemctl enable --now ydotool  # Fedora
```

Ubuntu/Debian ship an incompatible v0.1.8 - build v1.0.4 with the setup script:
```bash
curl -fsSL https://raw.githubusercontent.com/patrickjaja/claude-desktop-extra/master/scripts/setup-ydotool.sh | sudo bash
```

<a id="nixos"></a>
## NixOS

The bundled static bridges (`x11-bridge`, `wlroots-bridge`) run on NixOS as-is - X11, XWayland, and Sway/Hyprland/Niri Computer Use work with no extra packages. The glibc-dynamic bridges do not run on NixOS; the app's run check notices and moves on: KDE Wayland falls back to `spectacle` (baked into the flake's closure), and GNOME Wayland needs a natively built [`gnome-portal-bridge`](https://github.com/patrickjaja/gnome-bridge) passed via `claude-desktop.override { gnome-portal-bridge = …; }` (sets `GNOME_PORTAL_BRIDGE_BIN`).

For exotic Wayland compositors, the flake already bakes `ydotool` into the closure; enable the daemon with:

```nix
programs.ydotool.enable = true;  # exotic Wayland compositors only - the bundled bridges cover X11/Sway/Hyprland/Niri/GNOME/KDE
```
