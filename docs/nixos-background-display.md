# NixOS: a background display for Claude

`programs.claude-desktop-extra.backgroundDisplay` (in `nixosModules.default`) runs a headless sway display for one user as a systemd user service. Claude works there while you keep your own desktop:

- **Computer Use** acts on it as display 2 of [Computer Use on a background display](computer-use.md#computer-use-on-a-background-display).
- **Claude in Chrome** drives a browser that lives there, with its own profile and its own sign-ins (shops, mail, anything you log into once).

Claude Desktop itself keeps running on your desktop; the service does not start it. With lingering (on by default) the display starts at boot and keeps running without a login, so the browser and its sessions are ready whenever Claude Desktop or Claude Code connects.

## Setup

```nix
{
  imports = [ claude-desktop-extra.nixosModules.default ];

  users.users.alice.isNormalUser = true;   # the user must be declared (lingering is set there)

  programs.claude-desktop-extra.backgroundDisplay = {
    enable = true;
    user = "alice";
    # Everything below is optional; these are the defaults.
    # resolution = "1920x1080";
    # browser.package = pkgs.chromium;   # any Chromium-family browser (google-chrome, brave, ...)
    # vnc.enable = false;                # wayvnc, no password - see Security
    # keyring.withKey = "host+tpm2";     # how the keyring password is sealed; "host" without a TPM
    # autostart = [ "foot" ];            # more programs, started once
  };
}
```

After `nixos-rebuild switch` the unit is `claude-extra-display.service` in the user manager (`systemctl --user status claude-extra-display`).

`user` must be declared in `users.users` while `linger` is on (the default): the module sets `users.users.<user>.linger`. With `linger = false` the module leaves `users.users` alone and the display starts when the user logs in.

### First run

1. **Open the display.** Turn VNC on for the setup (`vnc.enable = true;`, see [Security](#security)), then on the machine use any VNC viewer on `localhost:5910`; from elsewhere `ssh -L 5910:127.0.0.1:5910 <host>` and the viewer on your side. With `vnc.unixSocket = true;` wayvnc listens on `$XDG_RUNTIME_DIR/claude-extra/vnc.sock` instead (only your user can open it): `ssh -L 5910:/run/user/<uid>/claude-extra/vnc.sock <host>`, then the viewer on `localhost:5910`.
2. **Install Claude in Chrome** in the browser there and sign in to it. The module already linked the native-messaging manifest into the browser's profile, so the extension finds the native host.
3. **Sign in to the sites** Claude should use, in that browser. Turn VNC off again afterwards if you do not need to watch.
4. **Point Computer Use at the display** (optional; Claude in Chrome does not need it): in Claude Desktop, Settings -> Extra -> Cowork (Linux) -> **Computer Use on a background display**. The setup page lists the display twice: as **Wayland display wayland-claude-extra** (the module's stable name) and as **Wayland display wayland-N** (sway's own socket, whose number can change between starts). Select `wayland-claude-extra`. To keep apps that Claude opens there on the display's own D-Bus (the module's private bus, see below), set the key by hand in `~/.config/Claude/claude-desktop-extra.jsonc` instead, with your uid in the path:

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
| VNC | off by default. `vnc.enable = true`: `wayvnc` on `vnc.address:vnc.port` (`127.0.0.1:5910`), or on `$XDG_RUNTIME_DIR/claude-extra/vnc.sock` with `vnc.unixSocket = true`; restarted when it exits. It has **no authentication** |
| clipboard | `wl-clipboard` is installed system-wide, for Computer Use's clipboard on the display |

Everything runs in the unit's cgroup: `systemctl --user stop claude-extra-display` ends all of it. The state directory is `dataDir` (default `~/.claude-extra`): a path relative to the home directory, of letters, digits and `._+-`, without `.` or `..` components.

## Security

- **The session is always unlocked.** The keyring is open and the browser is signed in from boot, without a login. Anything that runs as `user` can use them: send input to the display and its browser, read secrets from the keyring over the private bus, or reuse the browser's sign-ins. Run the display for an account whose other programs you trust with those sign-ins.
- **VNC has no password.** On a TCP address every local account can connect (other users, system services, containers on the host network) and drive the display; the module warns at build time when `vnc.address` is not a loopback address. Keep `vnc.enable` off unless you need it, use it on a single-user machine, or set `vnc.unixSocket = true` so only `user` can connect.
- **`keyring.withKey = "host"`** seals the keyring password with `/var/lib/systemd/credential.secret` only. Anyone who can read the root file system (a stolen unencrypted disk, root) can unseal it, so it protects the keyring as well as your disk encryption does. `host+tpm2` also needs this machine's TPM.

## Notes

- **The Claude package.** `claudePackage` defaults to this flake's `claude-desktop` package for the system: the manifest points at its `chrome-native-host`, so it is built or fetched with your system. If the Claude Desktop you run is another package (an `.override` of it, or a build from another input), set `claudePackage` to that same package so the native host matches the app you run.
- **aarch64.** The flake builds `claude-desktop` for x86_64 only, so on aarch64 `claudePackage` has no default and the build stops with an assertion. Set `browser.claudeNativeHost = false;` (the browser runs without the Claude manifest) or provide `claudePackage`.
- **Browsers that need a wrapper.** `browser.executable` overrides the command, for example a launcher that hides a global `LD_PRELOAD` malloc from Chromium: `browser.executable = "${myLauncher} ${pkgs.chromium}/bin/chromium";`.
- **No TPM.** With the default `keyring.withKey = "host+tpm2"` the first start cannot seal the password: the unit stops without restarting (exit 78) and the journal names the setting. Set `keyring.withKey = "host";` (see [Security](#security)) or `keyring.enable = false;`, rebuild, then `systemctl --user restart claude-extra-display`. The decryption runs in systemd, so the user needs no access to `/dev/tpmrm0`.
- **Keyring that no longer opens.** `keyring.cred` is sealed for this machine and user: after a new machine-id, a changed UID, a new host key or a cleared or replaced TPM it cannot be decrypted. systemd-creds cannot tell that apart from a credentials service or TPM that is not ready yet at boot, so the unit keeps retrying with a growing delay and the journal says, at each attempt, that the file cannot be decrypted. If `keyring.cred` is missing while the keyring exists, or the keyring rejects the password in it, the unit stops without restarting (exit 78). Restore the file, or move `~/.claude-extra/keyring.cred` and `~/.claude-extra/keyring` away to start an empty keyring (the browser's saved passwords and its encrypted cookies are lost; you sign in again), then `systemctl --user restart claude-extra-display`.
- **Other failures** (the keyring not answering in time, a GPU render node not there yet, a crash) restart the unit after 5 seconds, with the delay growing to 5 minutes over 10 restarts, for as long as the failure lasts. The exit-78 cases above stay stopped until fixed and restarted with `systemctl --user restart claude-extra-display`.
- **Claude Desktop while you are logged out** is not part of this module. It needs a desktop session or display of its own, and TPM access that does not depend on the active seat (for example the `tss` group) for cloud Cowork and Dispatch.

## Troubleshooting

```bash
systemctl --user status claude-extra-display
journalctl --user -u claude-extra-display -b
# what the display shows (grim is not installed by the module: nix-shell -p grim)
WAYLAND_DISPLAY=wayland-claude-extra grim /tmp/display2.png
```
