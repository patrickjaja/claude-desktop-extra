# Troubleshooting

Logs, bug reports, common fixes and known limitations. For the short version, see [Troubleshooting in the README](../README.md#troubleshooting).

## Reporting a bug

Attach these two to the issue:

```bash
claude-desktop --diagnose
cat ~/.config/Claude/logs/claude-patches.log
```

In 3P mode the log is under `~/.config/Claude-3p/logs/`, for a named profile under `~/.config/Claude-<profile>/logs/` (3P: `~/.config/Claude-<profile>-3p/logs/`).

`--diagnose` prints the session type, portal and hotkey state, a **Host capabilities** section (each host tool the app runs, whether it is found, and what stops working without it), a **Cloud Cowork device key** section (TPM access, the opt-in rule and the last remote-device connect), a **Local Cowork VM** section (the app's own probe: QEMU, firmware, virtiofsd, `/dev/kvm`, `/dev/vhost-vsock`), a **Computer Use** section (package version, a run check of every bundled bridge, and on KDE Wayland the KWin 6.6 check plus a portal-free self-test; window titles are never printed) and a closing **Problems found** list. Together with `claude-patches.log` this makes most reports diagnosable without follow-up questions.

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

## Main window goes blank and Ctrl+R does nothing

The main view's renderer exited and nothing is left to receive the reload key. The app reloads the view on its own when the renderer crashed (`reason: 'crashed'`) and, since [#287](https://github.com/patrickjaja/claude-desktop-extra/issues/287), when it exited cleanly without the app asking for it (`reason: 'clean-exit', exitCode: 0` - seen on niri Wayland with many Code sessions open). Check that it did:

```bash
grep -h "render process gone\|cdb-renderer" ~/.config/Claude/logs/main.log ~/.config/Claude/logs/claude-patches.log | tail
```

`[cdb-renderer] ... handing it to the reload path` followed by `Main webview render process gone` means the view was reloaded. `leaving it suppressed` names the reason: the app was quitting, or the view had already exited cleanly three times in ten minutes - a renderer that keeps exiting is left alone, as upstream does, and a restart is needed. Code sessions are not part of the main view and continue across its reload, as they do after a crash. If this hits you regularly, attach those lines to the issue.

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

## Quick Entry hotkey dead after a restart on Plasma 6.7.4+

Symptom: the first launch asks "Claude wants to register the following shortcut", the hotkey works, and after any restart it does nothing, while System Settings -> Shortcuts still lists it under Claude.

Cause: the bundled Electron registers the hotkey through the GlobalShortcuts portal and only binds a shortcut it does not find stored; since xdg-desktop-portal-kde 6.7.4 a stored shortcut stays inactive until the app binds it again. A bundled patch (`fix_quick_entry_kde_portal_rebind`) opens a second portal session on every launch and re-binds the stored shortcut, which Plasma accepts without a dialog. The portal's own view is on the bus:

```bash
dbus-monitor --session "interface='org.freedesktop.portal.GlobalShortcuts'"
```

A working launch shows `BindShortcuts` after `ListShortcuts`, and `Activated` on every press. `~/.config/Claude/logs/claude-patches.log` logs `[quick-entry] kde-rebind: armed 1 stored shortcut(s) for this session: Ctrl+Alt+Space` once the binding is in place, or the reason the patch stays inactive. `CDB_KDE_GS_REBIND=0` turns it off; binding `claude-desktop --toggle` to a key in System Settings -> Shortcuts -> Add New -> Command works without the portal.

A stored shortcut without a key never fires, however often it is re-bound: Plasma keeps a shortcut it was asked about even when the "register the following shortcut" dialog was dismissed, and `~/.config/kglobalshortcutsrc` then holds `...=none,Ctrl+Alt+Space,...` under `[com.anthropic.Claude]`. The log names that case: `armed 1 stored shortcut(s) for this session: <id> (no key assigned - set one in System Settings > Shortcuts > Claude)`. Assign the key there (or remove the Claude entry and restart the app for a new dialog).

## Quick Entry opens but shows no text field or ignores typing

Symptom: the bar opens with only the Claude mark in it, nothing typed appears, Enter closes it without sending, while Ctrl+V followed by Enter does send. Code in transcripts collapses to a text-less pill and code blocks show only their language label, while the surrounding text renders.

Cause: the app's renderers have no system font. claude.ai text renders because it ships its own web fonts, but the Quick Entry window's font, inline code and every fallback glyph need a font from fontconfig, and with none available the text has no size. Electron's Chromium carries its own fontconfig with its own cache format: it reads and writes `*.cache-NN` files in `~/.cache/fontconfig`, keyed by a hash of the font directory path, next to the distro's files of another format. A distrobox or toolbox container, or another Electron build, that shares `$HOME` writes a cache for the same hash with its own directory layout; the app trusts it and finds nothing, while `fc-match` on the host reads the other format and looks healthy. The launcher therefore starts the app with a private font cache: `~/.cache/claude-desktop/fontconfig/fonts.conf`, the distro's `/etc/fonts/fonts.conf` with the shared `<cachedir>` entries replaced by `~/.cache/claude-desktop/fontconfig/cache`. Font directories, `conf.d` and the user's own fontconfig stay as configured; the first start after the upgrade rescans the fonts once. `claude-desktop --diagnose` shows the config and cache the app uses under **Fonts**, together with `FONTCONFIG_FILE`, `FONTCONFIG_PATH`, `FONTCONFIG_SYSROOT` and `fc-match`; an explicit `FONTCONFIG_*` variable is kept (one that points at a missing path is dropped and logged), and `CLAUDE_PRIVATE_FONT_CACHE=0` restores the shared cache. On a build without the private cache, `rm ~/.cache/fontconfig/*.cache-11` after the container ran is the workaround.

Every time Quick Entry is shown, `claude-patches.log` gets one line describing what the window's renderer sees:

```
[quick-entry] shown 606x470 focused=true {"textarea":[536,40],"focused":true,"docFocus":true,"font":"anthropic-sans","color":"rgb(252, 252, 252)","placeholder":"rgb(161, 169, 177)","caret":"rgb(252, 252, 252)","fonts":"anthropic-sans:loaded ...","body":"darkTheme"}
```

A healthy window has a textarea about 40 px tall, `focused` and `docFocus` true, and the bundled `anthropic-sans` font loaded. The no-font case reads `anthropic-sans:error` with a 24 px textarea; `focused:false` points at keyboard focus (an input method or the compositor); `focused:true` with nothing visible and the font loaded points at the colors (a theme). Attach the line to a report together with `~/.config/Claude/logs/main.log`.

## Cowork or Dispatch says "No matching tools found" for Computer Use

Cloud Cowork and Dispatch offer this computer's Computer Use only to a desktop that registered with a TPM-backed device key. Without access to `/dev/tpmrm0` it registers keyless and the session gets no computer tools. Code tab sessions are unaffected.

1. Check: Settings -> Extra -> Cowork (Linux), or `claude-desktop --diagnose`, or `grep 'connect frame sent' ~/.config/Claude/logs/main.log` (`device_id keyed` is good, `keyless` is the problem).
2. Fix: click **Enable TPM access** on that page (`.deb`, `.rpm`, pacman), run the command it shows (AppImage, no logind), set `programs.claude-desktop-extra.tpmAccess.enable = true;` (NixOS), or `sudo usermod -aG tss $USER` and log in again.
3. Restart Claude and start a new Cowork task.

No TPM 2.0 on the machine: cloud Cowork and Dispatch cannot use Computer Use there; Code sessions still can. Security implications and how to turn it off: [Computer Use in cloud Cowork and Dispatch](computer-use.md#computer-use-in-cloud-cowork-and-dispatch).

On a keyless desktop every claude.ai chat and Cowork session header (`/chat/...`, `/cowork/...`) shows a laptop icon with an X ("No device key": no Computer Use for cloud tasks, files and commands still work); clicking it opens the Cloud Cowork section of that page. A keyed desktop whose chat is not linked to it shows an amber dot instead.

## Cowork has no "run on your computer" option

The local Cowork VM is optional with a claude.ai account: when the app's probe fails it hides the local option and only cloud Cowork is offered (third-party inference has no cloud Cowork, so Cowork is unavailable there). The probe needs `/dev/kvm` and `/dev/vhost-vsock` access plus QEMU, OVMF firmware and virtiofsd, and runs once at app start.

1. Check: Settings -> Extra -> Cowork (Linux) -> Local Cowork VM, or the **Local Cowork VM** section of `claude-desktop --diagnose`.
2. Fix the item it names: click **Enable KVM access** (`.deb`, `.rpm`, pacman), run the command the page shows (AppImage, no polkit agent), set `programs.claude-desktop-extra.kvmAccess.enable = true;` (NixOS), or `sudo usermod -aG kvm $USER` and log in again; install the missing VM tools per [Cowork setup](cowork.md#local-cowork-vm-setup).
3. Restart the app so it probes again (no relogin after Enable KVM access).

## A tool installed only for your user is not found

Since 4.23118 the app narrows its own `PATH` at startup to the system folders (`/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/snap/bin`, `/run/current-system/sw/bin`, `/run/current-system/profile/bin`, plus `/usr/local/bin` and `/usr/local/sbin` when only root can write them), so a program it runs by itself cannot come from a folder your user can write. The tools our patches run (`xdg-open` for links, `xdg-mime` for "Open in" editors, `hyprctl` for Quick Entry placement, `qemu-system-<arch>` for local Cowork, `secret-tool` / `kwallet-query` for Chrome cookie import, the Computer Use helpers) are also taken from folders of the `PATH` Claude Desktop was started with that only root can change: the NixOS package's store folders, `/etc/profiles/per-user/<you>/bin` (`users.users.<you>.packages`, the home-manager NixOS module), the RHEL `qemu-shim` folder. A copy in `~/.local/bin`, `~/.nix-profile/bin` (a standalone home-manager) or another folder you own is not run.

1. Check: `claude-desktop --diagnose` prints the **TOOL PATH** and, under **Host capabilities**, names a tool it found only in a folder you can write. `claude-patches.log` has one `[tool-path] <tool> found only in <folder>, a user-writable folder - ignored` line per tool.
2. Fix: install the tool system-wide (your package manager; on NixOS `environment.systemPackages` or `users.users.<you>.packages`), or as root in `/usr/local/bin`.
3. Links, "Open in ..." and sign-in run `xdg-open` from the system folders. Where `xdg-open` is not installed in a system folder but is available in one of the root-managed folders above (as with the Nix package's wrapper, which carries its own `xdg-utils`), the link opens with those folders on `PATH` for that call; where `xdg-open` is in a system folder (on NixOS: the system profile), nothing changes.

Programs you name yourself (an MCP server command, a Code session's tools, `CLAUDE_QEMU_PATH`, `COWORK_SCREENSHOT_CMD`, an app Computer Use opens) keep the `PATH` you started the app with. So does `git` for Diff views, the one tool of ours looked up the way the app itself looks up git for Code sessions: the `PATH` you started the app with comes first, so a `git` in `~/.local/bin` or a standalone home-manager profile is used.

## Known limitations

- **App identity on Wayland.** `xdg-desktop-portal` resolves unsandboxed apps via the systemd user scope. We launch under `app-com.anthropic.Claude-*.scope` and install the `.desktop` as `com.anthropic.Claude.desktop` - the same reverse-DNS identity the official build uses, and the value Chromium derives the window `app_id` / `WM_CLASS` from - so scope, `app_id`, `StartupWMClass` and `.desktop` basename all agree. KDE global shortcuts and persistent portal authorizations (screen share / Computer Use consent) attach to that id and survive across sessions.
  - Pinned taskbar/dock shortcuts from an earlier release (`claude-desktop.desktop` or older names) orphan on upgrade - **re-pin once**.
  - Custom X11/Wayland WM rules matching `claude-desktop` (or older `claude` / `com.anthropic.claude-desktop`) need updating to `com.anthropic.Claude`. The default profile's window `app_id` is `com.anthropic.Claude`; a named profile with its own `.desktop` file reports `com.anthropic.Claude-<name>`, so rules for the base id do not match it (see [profiles](profiles.md)).
  - KDE screen-share / Computer Use consent granted before the rename is keyed to the old id - re-grant once; it persists from then on.
  - GNOME shell-extension blacklists (Rounded Window Corners, Unite, Blur My Shell) referencing `com.anthropic.claude-quick-entry` should become `claude-quick-entry`.
  - **Sandboxes/containers** without a reachable user-systemd (bwrap, distrobox, restricted Flatpaks) auto-skip the scope wrap; force it with `--no-systemd-scope` / `CLAUDE_DISABLE_SYSTEMD_SCOPE=1` if the socket exists but is unreachable ([#89](https://github.com/patrickjaja/claude-desktop-extra/issues/89)).
- **Desktops without a tray host.** On a Wayland session where nothing provides a tray (`org.kde.StatusNotifierWatcher`: GNOME without the AppIndicator extension, sway or niri without a tray bar), closing the window quits the app instead of hiding it, and "Start at login" opens the window. For the login launch the tray is detected once at startup.
- **Keep computer awake on tiling compositors.** Where no GNOME or freedesktop power-management service runs (Sway, Hyprland, niri, i3, ...), the setting holds a logind idle inhibitor. logind's IdleAction and hypridle honor it; plain `swayidle` timeouts do not.
- **Computer Use targets the primary monitor** - screenshots/clicks can be retargeted with `switch_display`; the teach overlay stays on the primary display. See [computer-use.md](computer-use.md).
- **CoworkSpaces are local-only** on every platform (no account-sync) - a set created on macOS/Windows won't transfer to Linux. Upstream behavior.
