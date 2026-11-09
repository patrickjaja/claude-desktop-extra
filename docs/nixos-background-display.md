# NixOS: a background display for Claude

`programs.claude-desktop-extra.backgroundDisplay` (in `nixosModules.default`) runs a headless sway display for one user as a systemd user service. Claude works there while you keep your own desktop:

- **Computer Use** acts on it as display 2 of [Computer Use on a background display](computer-use.md#computer-use-on-a-background-display).
- **Claude in Chrome** drives a browser that lives there, with its own profile and its own sign-ins (shops, mail, anything you log into once over VNC).

Claude Desktop itself keeps running on your desktop; the service does not start it. With lingering (on by default) the display starts at boot and keeps running without a login, so the browser and its sessions are ready whenever Claude Desktop or Claude Code connects.

## Setup

```nix
{
  imports = [ claude-desktop-extra.nixosModules.default ];

  programs.claude-desktop-extra.backgroundDisplay = {
    enable = true;
    user = "alice";
    # Everything below is optional; these are the defaults.
    # resolution = "1920x1080";
    # browser.package = pkgs.chromium;   # any Chromium-family browser (google-chrome, brave, ...)
    # vnc.port = 5910;                   # wayvnc on 127.0.0.1, no password
    # keyring.withKey = "host+tpm2";     # how the keyring password is sealed
    # autostart = [ "foot" ];            # more programs, started once
  };
}
```

After `nixos-rebuild switch` the unit is `claude-extra-display.service` in the user manager (`systemctl --user status claude-extra-display`).

### First run

1. **Open the display.** On the machine: any VNC viewer on `localhost:5910`. From elsewhere: `ssh -L 5910:127.0.0.1:5910 <host>`, then the viewer on your side.
2. **Install Claude in Chrome** in the browser there and sign in to it. The module already linked the native-messaging manifest into the browser's profile, so the extension finds the native host.
3. **Sign in to the sites** Claude should use, in that browser.
4. **Point Computer Use at the display** (optional; Claude in Chrome does not need it): in Claude Desktop, Settings -> Extra -> Cowork (Linux) -> **Computer Use on a background display**, choose `wayland-claude-extra`. To keep apps that Claude opens there on the display's own D-Bus (the module's private bus, see below), set the key by hand in `~/.config/Claude/claude-desktop-extra.jsonc` instead, with your uid in the path:

   ```jsonc
   {
     "computerUseBackgroundDisplay": {
       "enabled": true,
       "kind": "wlroots",
       "display": "wayland-claude-extra",
       "env": { "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/claude-extra/bus" }
     }
   }
   ```

Claude Desktop finds the browser by itself: the native host the browser starts listens on a socket in `/tmp/claude-mcp-browser-bridge-<user>/`, which Claude Desktop (and Claude Code) watch. With a browser on your desktop as well, Claude sees both and picks one with its `select_browser` tool; ask it to use the one on the background display.

## What runs, and where things are

| Part | Detail |
|---|---|
| sway | `WLR_BACKENDS=headless`, `pixman` renderer (no GPU needed; `renderer` option for `gles2`/`vulkan`), one output at `resolution`, XWayland off (`xwayland` option) |
| Wayland socket | `$XDG_RUNTIME_DIR/wayland-claude-extra` (`socketName`), a symlink to sway's own `wayland-N`, removed when the unit stops |
| D-Bus | a private session bus at `$XDG_RUNTIME_DIR/claude-extra/bus`: single-instance apps, notifications, portals and the keyring on the display never reach your desktop session, and nothing from your desktop reaches the display |
| keyring | gnome-keyring on that bus, data in `~/.claude-extra/keyring/`. Its password is random, created on first start and sealed with `systemd-creds --user --with-key=host+tpm2` in `~/.claude-extra/keyring.cred`, so it unlocks at every start without a login and only on this machine. The browser keeps its cookie and password encryption key there (`--password-store=gnome-libsecret`). `keyring.enable = false` uses `--password-store=basic` instead (a fixed, publicly known key) |
| browser | `browser.package` with `--user-data-dir=~/.claude-extra/chrome-data`, `--ozone-platform=wayland`; restarted when it exits. Claude's native-messaging manifest is linked into `chrome-data/NativeMessagingHosts/` and points at the `chrome-native-host` of `claudePackage` |
| VNC | `wayvnc` on `vnc.address:vnc.port`, restarted when it exits. It has **no authentication**: keep it on `127.0.0.1` |
| clipboard | `wl-clipboard` is installed system-wide, for Computer Use's clipboard on the display |

Everything runs in the unit's cgroup: `systemctl --user stop claude-extra-display` ends all of it. The state directory is `dataDir` (default `~/.claude-extra`).

## Notes

- **Browsers that need a wrapper.** `browser.executable` overrides the command, for example a launcher that hides a global `LD_PRELOAD` malloc from Chromium: `browser.executable = "${myLauncher} ${pkgs.chromium}/bin/chromium";`.
- **No TPM.** `keyring.withKey = "host"` seals with the host key only (`/var/lib/systemd/credential.secret`). `host+tpm2` fails on a machine without a TPM instead of falling back. The decryption runs in systemd, so the user needs no access to `/dev/tpmrm0` for it.
- **Lost `keyring.cred`.** The keyring cannot be unlocked without it; the unit then fails without restarting (exit 78) and the journal says so. Restore the file, or move `~/.claude-extra/keyring` away to start an empty keyring (the browser's saved passwords and its encrypted cookies are lost; you sign in again).
- **Claude Desktop while you are logged out** is not part of this module. It needs a desktop session or display of its own, and TPM access that does not depend on the active seat (for example the `tss` group) for cloud Cowork and Dispatch.

## Troubleshooting

```bash
systemctl --user status claude-extra-display
journalctl --user -u claude-extra-display -b
WAYLAND_DISPLAY=wayland-claude-extra grim /tmp/display2.png    # what the display shows
```
