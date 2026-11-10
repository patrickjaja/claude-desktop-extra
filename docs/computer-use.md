# Computer Use

**On for every account and every session type.** The official build's own Linux Computer Use is a staged rollout that needs a RemoteDesktop portal and skips wlroots; our bundled bridges take precedence. Claude Desktop's built-in Computer Use MCP server exposes 27 tools for desktop automation (screenshot, click, type, scroll, drag, clipboard, and more). The **learn tools** (`learn_application`, `learn_screen_region`) generate interactive overlay tutorials that walk through any application's UI step by step.

Example prompt: *"Can you use computer use MCP to explain me the PhpStorm application?"*

**How it works on Linux:** upstream Computer Use is macOS-only - gated behind `process.platform==="darwin"`, macOS TCC permissions, and a native Swift executor. The patch ([`fix_computer_use_linux.nim`](../patches/linux/fix_computer_use_linux.nim)) removes the platform gates, routes both upstream executor factories to an injected Linux executor, leaves the OS-permission step to upstream, which reports it granted on Linux itself, and auto-detects your session type to route to a bundled first-party bridge: [`x11-bridge`](https://github.com/patrickjaja/x11-bridge) on X11 / XWayland, [`wlroots-bridge`](https://github.com/patrickjaja/wlroots-bridge) on Sway / Hyprland / Niri, [`gnome-portal-bridge`](https://github.com/patrickjaja/gnome-bridge) on GNOME Wayland, and [`kwin-portal-bridge`](https://github.com/patrickjaja/kwin-portal-bridge) on KDE Wayland. The bridges ship inside the package, so X11, XWayland, Sway / Hyprland / Niri, GNOME Wayland on PipeWire >= 1.0.5 (Ubuntu 24.04+, Fedora 40+, Debian 13+) and KDE Plasma 6.6+ need nothing installed. Older GNOME and KDE sessions, NixOS GNOME / KDE and exotic compositors take a fallback; [Computer Use dependencies](computer-use-dependencies.md) has the matrix, how each bridge works and the fallbacks. The app also reports Computer Use to claude.ai as rolled out on Linux ([`enable_local_agent_mode.nim`](../patches/linux/enable_local_agent_mode.nim) forces the `computerUseRollout` feature), so Team and Enterprise accounts without a web rollout get the **Settings -> System -> Computer use** section with its **Enable computer use** switch instead of "Computer use isn't available on the Team and Enterprise plans yet". Turn that switch on once; Code sessions on this computer and Cowork tasks then carry the `computer-use` tools (claude.ai lists Computer Use for those two session kinds; a plain chat reaches a computer only through claude.ai's own device linking). Organization compliance settings are honoured as on macOS and Windows: when your org restricts Computer Use, the server is not registered and, if the restriction lands mid-session, every further tool call is refused with the same message upstream shows; claude.ai checks that compliance lock before the rollout, so it is not lifted by the override.

**Notes:**
- **Which monitor.** Screenshots and clicks target the primary display; use `switch_display` to target another (the teach overlay stays on the primary). In cloud Cowork, Dispatch and on KDE Wayland, once apps are approved the next screenshot goes to the monitor holding most of their visible windows, as on macOS; it is picked again whenever the approved apps change, unless Claude chose a monitor with `switch_display`. This needs window positions: X11 (and XWayland with Electron on XWayland) and KDE Wayland report them; on GNOME Wayland and on sway, Hyprland and river the bridges report none, so the screenshot stays on the default monitor. `claude-patches.log` has one `[claude-cu] display auto-target:` line per decision. On GNOME Wayland the default is the monitor shared in the "Remote Desktop" consent dialog instead: with several monitors, share all of them there, otherwise only the shared one is used by default. To change the selection later (GNOME and KDE Wayland), run `claude-desktop --reset-screen-sharing`; the next Computer Use task shows the dialog again. When Claude reports a monitor as not shared, it asks you to run the same command. Clicking "Stop sharing" in the desktop's screen-sharing indicator (GNOME and KDE Wayland) stops Computer Use: Claude asks you before continuing, and the block is lifted when the task ends (the app checks the session's state every 10 seconds, so within about 10 seconds of the turn end, and immediately when the page or Claude releases Computer Use) or after about 2 minutes without Computer Use actions. The bridge session itself also ends at those points, so the desktop's screen-sharing indicator disappears; the next action shares again without a dialog once the selection is remembered. The teach overlay still opens on Electron's primary display, so when the shared monitor is a different one, teach tooltips appear on the primary display rather than the monitor being captured.
- **Scaling and layouts.** X11 sessions with a scale factor (`Xft.dpi`, `GDK_SCALE`, `--force-device-scale-factor`) are supported: clicks and screenshots use the same DIP-to-pixel mapping. On sway, Hyprland and river, monitors at negative offsets (left of or above the origin) and rotated or flipped monitors work. On KDE Wayland, the first Computer Use action of a session waits up to about two minutes for the consent dialog and reports it if you decline.
- **App discovery** (listing and opening apps, the teach overlay) reads `.desktop` files from `$XDG_DATA_HOME/applications` and every `$XDG_DATA_DIRS/applications` (which covers NixOS profiles, snap and `/usr/local`), plus the Flatpak export dirs, registering each with multiple name variants for flexible matching; a match on the app's name or desktop id wins over one on its executable name. On wlroots, GNOME and X11 sessions `open_application` runs the launcher's full `Exec` line as the Desktop Entry spec defines it (field codes, quoting, `Path=`, `TryExec`), so Flatpak apps, Chromium web apps and `env`-wrapped launchers start correctly. When a launcher has no usable `Exec`, is `Terminal=true`, or its binary is missing, it falls back to whichever of `gio launch`, `gtk-launch`, `kioclient6`/`kioclient5 exec` and `exo-open` is installed (plus `xdg-terminal-exec`, `x-terminal-emulator -e` or `$TERMINAL -e` for terminal apps); none of them is required.
- **Which `PATH`.** Apps are found on the `PATH` Claude Desktop was started with, so launchers whose `Exec` names a program in `~/.local/bin`, `~/.nix-profile/bin` or a home-manager profile open, on your desktop and on the background display. The tools Computer Use runs itself (`setsid`, the launcher tools above, the clipboard tools, `ydotool`, ...) come from system folders and from root-managed read-only folders on that `PATH`: on NixOS the system profile and `/etc/profiles/per-user/<you>` (`users.users.<you>.packages` and the home-manager NixOS module); a standalone home-manager or `~/.nix-profile` is managed by your user and is not used for tools. A tool found only in a folder your user can write to counts as missing, and `claude-patches.log` names the folder it ignored: install the tool system-wide (your package manager; on NixOS `environment.systemPackages` or `users.users.<you>.packages`), or as root in `/usr/local/bin`. URLs and files open through the system `xdg-open`.
- **Teach mode** (the learn tools' overlay tours) works on X11 and on KDE Plasma Wayland, where it follows the account's teach-mode setting; it is not available on wlroots or GNOME sessions and is refused on the background display.
- **Teach overlay** stays interactive but blocks clicks to apps behind it during a tour (Electron's `setIgnoreMouseEvents` is [broken on X11](https://github.com/electron/electron/issues/16777)).

## Approving apps

Settings -> Extra -> Cowork (Linux) -> **Ask before Computer Use controls an app** (on by default). Claude names the apps it wants in `request_access`, and you approve them in the approval card in the chat, as on macOS. Approved apps get full control: clicks, typing and key presses, also for terminals, editors and browsers (macOS limits those to "read" or "click"). The card still offers the clipboard and system key combo checkboxes, and warns for terminals and file managers.

The switch governs Code sessions (the Code tab and local Cowork) on X11, wlroots, GNOME and the background display. Sessions that upstream runs itself already ask, whatever the switch says: cloud Cowork, Dispatch and teach mode pass their own approved apps to Computer Use, and their screenshots are masked by that list where the session can mask (see the table). Approved apps get full control in all of them on these sessions, also with the switch off. On KDE Plasma Wayland upstream handles everything.

With approval on, Computer Use refuses:

- every tool until at least one app is approved (a session without an approval card gets upstream's "not wired with a permission handler" answer, so nothing can be approved there);
- clicks, scrolls and drags on a window of an app you did not approve, and typing and key presses while such an app is in front, as far as the session can tell (see the table). A drag by hand (`left_mouse_down`, `mouse_move`, `left_mouse_up`) is checked at every move and at the release; a refused release still lets go of the button;
- input when the session could not tell which app is in front (the window list failed), rather than guessing; with nothing focused at all input is allowed, as upstream does;
- clipboard access and system key combos (lock screen, switch app, quit, Super on its own, XF86 keys, in any spelling the bridges accept such as `Super_L` or `page_up`) unless you ticked them in the card;
- `open_application` and the accessibility tools for an app you did not approve.

Apps are matched by their app id (the .desktop id and its aliases), never by a window title or display name. Where the session has a hit test, a click on one of Claude's own windows is refused as well.

What screenshots show and how input is checked depends on the session:

| Session | Screenshots | Input check |
|---|---|---|
| X11, X11 background display (x11-bridge) | Only the approved apps; other windows are covered by solid rectangles | The app under the pointer and the app in front |
| Sway, Hyprland, background display on headless sway (wlroots-bridge) | Only the approved apps; popup menus, layer-shell panels and overlays, and (sway) XWayland menus can still show over or next to an approved window | The app under the pointer (approximate: from the compositor's window rectangles, popups and layer-shell surfaces are not seen) and the app in front |
| Niri, river (wlroots-bridge) | The whole screen, including apps you did not approve | The app in front |
| GNOME Wayland (gnome-portal-bridge) | The whole screen, including apps you did not approve | The app in front |
| XWayland-only, fallback route (ydotool / spectacle) | The whole screen | Only "at least one app approved" |
| KDE Plasma Wayland (KWin mode) | Upstream's own handling: only the approved apps | Upstream's own checks; Claude always asks here, whatever the switch says |

On sessions without a hit test (the app in front only), a click lands on whatever is under the pointer; it is refused only while an unapproved app is in front. With one of Claude's own windows in front such a click is not refused (Claude's window stands for the shared screen, as upstream treats it), but typing is.

Masking needs a bundled bridge that supports it; an older or custom bridge (`*_BRIDGE_BIN`) without it gives the whole screen, and the status line says so. When the bridge cannot say whether it can mask (its `doctor` failed) or a masked capture fails, the screenshot is refused; it is never taken unmasked in its place.

Where screenshots show the whole screen, Claude is told so in the tool descriptions and with the first such screenshot of each task. Settings -> Extra -> Cowork (Linux) shows a line under **This desktop** saying which case applies to your session, from what the last screenshot actually did ("Screenshots show only approved apps", with what the mask does not cover on Sway and Hyprland, or "On this session (...) screenshots show the whole screen, including apps you did not approve").

**What Claude is told about access.** The system-prompt note for local sessions, the capability the Settings -> Computer use page and the enable dialog describe (per-app access), the enable-prompt card and the "Entire screen" choice follow what your session's backend really does:

| Session | Per-app access |
|---|---|
| KDE Plasma Wayland (KWin mode) | Yes (upstream's own handling) |
| X11, X11 background display | Yes |
| Sway, Hyprland, background display on headless sway | Yes, by masking; popups and layer-shell surfaces can still show |
| GNOME Wayland, Niri, river, fallback route (ydotool / spectacle) | No: the whole screen is visible |
| Any session with **Ask before Computer Use controls an app** off | No (KDE Plasma Wayland excepted) |

**Turn it off** with the switch, or with `"computerUseAskBeforeControl": false` in `claude-desktop-extra.jsonc` in the profile's userData directory (`~/.config/Claude/`; a value there locks the switch). Off, every app can be controlled without asking in Code sessions: `request_access` answers at once, nothing is checked and screenshots show the whole screen, as in earlier versions. Cloud Cowork, Dispatch and teach mode keep upstream's own approval and masking. The change applies from Claude's next Computer Use call; tool descriptions follow in the next session.

All four bridges implement one [command-line contract](computer-use-bridge-contract.md), which `claude-desktop --diagnose` and `--reset-screen-sharing` rely on, so they work with whatever bridges are bundled. The contract includes the optional `abort-watch` subcommand (x11-bridge, wlroots-bridge, kwin-portal-bridge) behind [Escape stops Computer Use](#stopping-computer-use); each bridge's README has its own details.

See [CLAUDE_BUILT_IN_MCP.md](../baseline/CLAUDE_BUILT_IN_MCP.md#17-computer-use) for the full tool reference, and [Computer Use dependencies](computer-use-dependencies.md) for the package matrix, the KDE/GNOME portal behavior notes, `COWORK_SCREENSHOT_CMD`, and `ydotool` v1.0+ setup.

**Debugging:** Computer Use patches emit `[claude-cu] diagnostics:` lines showing the detected session, available/missing tools, and screenshot cascade. Find them in `~/.config/Claude/logs/claude-patches.log` (also printed to stderr on terminal launches) and share that file when reporting Computer Use issues. See also [Debugging](../README.md#debugging).

## Stopping Computer Use

- **Stop** in the app stops the running task.
- **Stop sharing** on the GNOME or KDE screen-share indicator stops the running Computer Use turn at once (always on); so does the desktop ending the share itself, for example a portal restart. An Escape Claude itself presses is marked as expected, so Anthropic's X11 Escape handler does not take it for yours.
- **Escape** stops Computer Use on X11, Hyprland, sway and KDE Plasma Wayland when you switch on **Escape stops Computer Use** under Settings -> Extra -> Community Features or on the Extra -> Computer Use page (off by default; off keeps Anthropic's own handling). What Escape does to your apps differs per desktop, and GNOME and niri have no stop key: see [Escape stops Computer Use](cu-escape-abort.md).

## Computer Use in cloud Cowork and Dispatch

Cowork and Dispatch tasks that run in the cloud reach this computer's Computer Use only when the desktop has registered with a TPM-backed device key. Without read and write access to `/dev/tpmrm0` (the TPM 2.0 resource manager) the desktop registers keyless, and those sessions get no computer tools ("No matching tools found"). Code tab sessions use Computer Use locally and are not affected. A computer without a TPM 2.0 cannot offer Computer Use to cloud Cowork or Dispatch; Code sessions still work there.

On Wayland, with one of the bundled bridges (KWin, GNOME or wlroots) in use, the computer tools are offered to cloud sessions as well: the announce, the call check (no "needs an Xorg session" refusal) and the approval card's app icons all follow the same answer. Sessions that fall back to ydotool or spectacle are not offered. If you turn the background display off while Claude Desktop runs and no bundled bridge remains usable, Computer Use calls from cloud Cowork and Dispatch are refused on that Wayland session until the app restarts (the tool list may still show the tools until Anthropic's code next refreshes it).

**Check.** Any of:

- Settings -> Extra -> Cowork (Linux) (the Cloud Cowork section shows the device key (TPM) and whether cloud Cowork and Dispatch can use this computer; the Computer Use section shows this desktop).
- `claude-desktop --diagnose`: the `device key (TPM)`, `TPM access rule` and `last remote-device connect` lines in the Cloud Cowork device key section.
- `~/.config/Claude/logs/main.log`: `connect frame sent: device_id keyed` (works) or `keyless` (no computer tools).
- The chat header: every claude.ai chat and Cowork session (`/chat/...` and `/cowork/...`) shows a device icon. On a desktop without a device key it is a laptop with an X, and its popover ("No device key") says cloud tasks can't use Computer Use (screen and input) on this computer while files and commands still work, with a link that opens Settings -> Extra -> Cowork (Linux). Keyed but not linked to this chat: laptop with an amber dot. Device key state not known yet: a plain laptop. Linked chats and chats that run in the local VM show the upstream icon with an added "Linux details" row that opens the same page. Each popover carries one line on where the chat runs (cloud; for a linked chat, files and commands run in the linked computer's local Cowork VM, with its state; or the local VM on this computer).

**Fix.**

| Install | Action |
|---|---|
| `.deb`, `.rpm`, pacman | Settings -> Extra -> Cowork (Linux) -> **Enable TPM access** (shows the exact command; asks you to confirm, then for an administrator password) |
| AppImage, or no logind session | Run the command the panel shows |
| NixOS | `programs.claude-desktop-extra.tpmAccess.enable = true;` with `imports = [ claude-desktop-extra.nixosModules.default ];`, then rebuild |
| Any | Alternative: `sudo usermod -aG tss $USER`, then log out and back in |

Then restart Claude and start a **new** Cowork task; a running task keeps the tools it started with.

**Security.** The rule gives read/write access to `/dev/tpmrm0` (the resource manager, never `/dev/tpm0`) to every account that logs in at this computer's screen (the active local seat), not only yours. Any program such an account runs can then use the TPM, including clearing it (which destroys TPM-sealed keys such as LUKS/`systemd-cryptenroll` or BitLocker keys), triggering its dictionary-attack lockout, or setting its owner or lockout password. If the TPM's lockout or owner authorization is empty, set one first: `tpm2_changeauth -c lockout` and `tpm2_changeauth -c owner`. Enable shows this in a confirmation dialog before the administrator prompt. Turn it off with **Disable TPM access** in the same panel (or the command it shows); access already granted lasts until you log out. The panel always shows both commands (each with its "What this does" details); the one that has nothing to do right now is greyed with the reason, and the row warns when access exists only until logout (no rule installed, not in the device's group). Uninstalling the package leaves the link in `/etc/udev/rules.d/` (it stops working once the package is gone), and reinstalling makes TPM access active again; to remove it for good, use **Disable TPM access** before uninstalling, or delete `/etc/udev/rules.d/70-claude-desktop-extra-tpm.rules`.

## Read app controls through accessibility (experimental)

Settings -> Extra -> Cowork (Linux) -> **Computer Use: read app controls (accessibility)** (off by default) gives Claude the app-scoped tools `app_list_windows`, `app_ax_find`, `app_click` and `app_type`. `app_ax_find` lists a window's controls (role, name, states, position) from the desktop accessibility bus (AT-SPI), and `app_click` / `app_type` press a control or set a text field by its `[N]` index, so Claude finds controls by name instead of by screenshot coordinates. With the switch off the tools do not exist and nothing touches the accessibility bus.

While a Computer Use session uses it, Claude turns the desktop accessibility service on, and turns it back off when the session ends (a crash is healed at the next start). A running screen reader is never touched. The text of password fields and terminals is never read. It needs `at-spi2-core` (installed with every common desktop). Switching the desktop accessibility setting on or off yourself during a Computer Use session is overridden: Claude Desktop switches it on when the tools are used and back to the previous value afterwards.

| Session | Coverage |
|---|---|
| X11 / XWayland, KDE Plasma Wayland | Controls with names, states and screen positions |
| GNOME Wayland, Sway / Hyprland / Niri | Names and actions; positions where the compositor reports them (Sway and Hyprland IPC), otherwise "position unknown" and Claude uses a screenshot to click. On GNOME, XWayland apps report positions as unknown |

GTK, Qt, Firefox and LibreOffice apps expose their controls. Electron and Chromium apps expose almost nothing unless started with `--force-renderer-accessibility`; Claude uses screenshots there. Every missing piece (no `at-spi2-core`, no matching window) gives a plain "unavailable" answer and normal Computer Use carries on.

## Computer Use on a background display (experimental)

By default Computer Use acts on your own desktop: Claude's mouse and keyboard are yours, so you cannot work while it runs. The **Computer Use on a background display** switch (Settings -> Extra -> Cowork (Linux), marked **Experimental**) moves it to a second display.

- **Display 1** is your desktop - where you chat with Claude and keep working.
- **Display 2** is a separate display that you start yourself: an invisible X server (Xvfb), an X server in a window (Xephyr), or a headless or nested wlroots compositor (sway, labwc). Claude opens apps there, clicks, types and takes screenshots there. It never moves your mouse or takes your focus.

Use it to let Claude work in the background while you keep your desktop, to keep Claude away from what is open on your desktop, or to run a task on a machine with no free screen. Switch the feature off (or leave it off) and Computer Use behaves as before, with no restart. Display 2 works the same on every host session (X11, XWayland, Sway / Hyprland / Niri, GNOME, KDE). You start and stop it; the app never does.

**Display 2 is required, never optional.** While the switch is on and display 2 is not running, every Computer Use action is refused with a message saying so; Computer Use never falls back to your desktop. Your own display (the one Claude Desktop runs on) is never selectable.

### Start display 2

Pick one. The setup panel (Settings -> Extra -> Cowork (Linux) -> the row's setup page) shows these recipes with a free display number filled in, and installs hints for what is missing on your machine.

**Xvfb plus a window manager** (invisible; the window manager lets Claude switch between windows):

```bash
Xvfb :99 -screen 0 1600x900x24 -nolisten tcp &
DISPLAY=:99 openbox &        # or xfwm4
```

**Xephyr** (display 2 as a window on your desktop, handy to watch what Claude does):

```bash
Xephyr :98 -screen 1600x900 -no-host-grab &
DISPLAY=:98 openbox &
```

**Headless sway** (invisible Wayland; the new `wayland-N` socket shows up in the panel's list):

```bash
env -u WAYLAND_DISPLAY -u DISPLAY WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 sway &
```

A nested sway (started inside your own session without `WLR_BACKENDS=headless`) or labwc works the same way. On NixOS, `programs.claude-desktop-extra.backgroundDisplay` runs a headless sway as a user service, with a browser, a keyring and optional wayvnc: see [NixOS background display](nixos-background-display.md). If sway starts XWayland for its apps, give Claude the `DISPLAY` it picked through `env` (see below).

| Distro family | Xvfb | Xephyr | window manager | sway | x11vnc / wayvnc |
|---|---|---|---|---|---|
| Arch | `xorg-server-xvfb` | `xorg-server-xephyr` | `openbox`, `xfwm4` | `sway` | `x11vnc`, `wayvnc` |
| Debian / Ubuntu | `xvfb` | `xserver-xephyr` | `openbox`, `xfwm4` | `sway` (1.7+) | `x11vnc`, `wayvnc` |
| Fedora | `xorg-x11-server-Xvfb` | `xorg-x11-server-Xephyr` | `openbox`, `xfwm4` | `sway` | `x11vnc`, `wayvnc` |
| RHEL 9 and clones | `xorg-x11-server-Xvfb` (AppStream, no extra repo) | - | `openbox` (EPEL) | not in the base repos: use Xvfb | `x11vnc` (EPEL) |
| NixOS | `nix shell nixpkgs#xvfb nixpkgs#openbox` | `nixpkgs#xorg-server` (older channels: `xorg.xorgserver`) | `nixpkgs#openbox` | `nixpkgs#sway` | `nixpkgs#x11vnc`, `nixpkgs#wayvnc` |

On immutable distros (Bazzite, Silverblue, SteamOS) install the tools in a distrobox container and start display 2 there. The X socket in `/tmp/.X11-unix` and the Wayland socket in `$XDG_RUNTIME_DIR` are visible to the host when the container shares them (distrobox does by default), so the panel finds them. Apps Claude starts run on the host, which is also where Claude Desktop runs.

### Turn it on

Open Settings -> Extra -> Cowork (Linux) -> **Computer Use on a background display**. The setup page lists the displays it finds (your own is labelled "your desktop" and cannot be chosen), each with size, outputs, whether it is supported and a live preview, shows the restrictions that apply on this machine right now, and has a **Test** button that takes a screenshot and moves the pointer on the chosen display. Choose a display, switch it on; it applies from Claude's next Computer Use action.

The same setting is the `computerUseBackgroundDisplay` key in `claude-desktop-extra.jsonc` in the profile's userData directory (`~/.config/Claude/`; per profile, so a named profile has its own). A key set in the `.jsonc` wins over the page and makes the page read-only:

```jsonc
{
  "computerUseBackgroundDisplay": {
    "enabled": true,
    "kind": "wlroots",             // "x11" (x11-bridge, Xvfb/Xephyr) or "wlroots" (wlroots-bridge)
    "display": "wayland-1",        // ":99" for x11; a socket name or absolute socket path for wlroots
    "env": { "DISPLAY": ":2" }     // optional, hand-edited only: variables for every app and bridge Claude starts there
  }
}
```

`env` carries what display 2 needs beyond its display name, for example the XWayland `DISPLAY` of a headless sway, an `XAUTHORITY`, or a private `DBUS_SESSION_BUS_ADDRESS` (see the limits below). Values are strings; `PATH`, `CLAUDE_ELECTRON` and `LD_*` are rejected. The page never writes `env` (it keeps what you wrote); choosing a different display on the page drops it, because it belongs to one display.

### Watch what Claude does

Attach a VNC viewer to display 2 (the panel has both recipes):

```bash
x11vnc -display :99 -localhost -nopw -forever &                 # X display, then connect to localhost:5900
WAYLAND_DISPLAY=wayland-1 wayvnc 127.0.0.1 5901 &               # Wayland display, then connect to localhost:5901
```

With Xephyr the window itself is the view.

### Limits

- **Single-instance apps open on your desktop.** An app that is already running on display 1 and hands every new launch to its running instance (Firefox, Chromium, many GTK apps on the shared session D-Bus) opens its window there, not on display 2. Claude is told the app did not open on the Computer Use display and why. Close the app on your desktop first, give it a separate profile (for Firefox, `-no-remote -P <profile>`), or start display 2 with its own D-Bus through `env` (`DBUS_SESSION_BUS_ADDRESS`; that costs the keyring, portals and notifications on display 2).
- **The shared session bus** also means portal file choosers and desktop notifications from apps on display 2 appear on your desktop.
- **No teach overlay.** Teach tours would draw on your desktop, so they are refused in this mode.
- **The "Claude is using your computer" glow** still shows on your desktop.
- **KDE Plasma 6.6+** picks its Computer Use mode when the app starts, so switching the feature on or off needs a restart there (the panel offers it).
- **Clipboard** needs `xclip` or `xsel` for an X display and `wl-clipboard` (`wl-copy`, `wl-paste`) for a Wayland display, installed on your machine (system-wide, see **Which `PATH`** above). Without them Claude's clipboard read and write are refused with a message naming the tool; your own clipboard is never touched.
- **The setup page can preview and test every display it can reach except Claude's own**, including another session of yours (for example a second login on `:1`).
- **Without a `DISPLAY` variable** (a pure Wayland session where Claude has no XWayland display exported), Claude cannot tell which X display number belongs to your desktop's XWayland. Do not choose that number as display 2.
- **Changes to the setting** are noticed at Claude's next Computer Use action. An editor that rewrites `claude-desktop-extra.jsonc` in place with the same size within the same second may go unnoticed until the next change on older kernels; the Settings page does not have this problem.
- `open_application` accepts desktop entries and commands, not URLs, in this mode.
- Window activation is limited on an X display without a window manager; run one (openbox, xfwm4) on display 2.

### Unsupported targets

Headless GNOME Shell or KWin (the portal bridges need a desktop session bus and a consent dialog on a screen nobody sees), weston (no virtual-pointer or screencopy protocol), cage (a single-app kiosk) and Hyprland or niri headless (no supported headless start). The panel marks such a display as not supported and says why.
