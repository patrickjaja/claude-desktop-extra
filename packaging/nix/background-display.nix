# NixOS module: a headless sway "background display" for one user, run as a
# systemd user service. It is display 2 of the Computer Use background-display
# feature (docs/computer-use.md#computer-use-on-a-background-display) and the
# home of a browser that Claude in Chrome drives. Claude Desktop itself keeps
# running on the user's own desktop; nothing here starts it.
#
#   imports = [ claude-desktop-extra.nixosModules.default ];
#   programs.claude-desktop-extra.backgroundDisplay = {
#     enable = true;
#     user = "alice";
#   };
#
# What the service runs, all inside one cgroup (stopping the unit stops all):
#   - a private D-Bus session bus at $XDG_RUNTIME_DIR/claude-extra/bus, so
#     single-instance apps, the keyring and portals on display 2 never reach the
#     user's desktop session (docs: "Single-instance apps open on your desktop");
#   - optionally a gnome-keyring on that bus whose password is a random secret
#     sealed with systemd-creds (host+tpm2 by default), so the browser's cookie
#     key survives reboots without anyone logging in;
#   - headless sway, its socket reachable under a stable name
#     ($XDG_RUNTIME_DIR/<socketName>, a symlink to sway's wayland-N);
#   - optionally wayvnc (off by default; localhost or a private Unix socket), a browser with its own profile
#     and the Claude in Chrome native-messaging manifest, and extra programs.
#
# State lives under ~/<dataDir> (default ~/.claude-extra): chrome-data/,
# keyring/ and keyring.cred.
{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.claude-desktop-extra.backgroundDisplay;
  inherit (lib) mkOption mkEnableOption types;
  system = pkgs.stdenv.hostPlatform.system;

  # Bus, keyring control socket: per-boot, under the user's runtime dir.
  runSub = "claude-extra";

  hostManifests =
    lib.optionalAttrs (cfg.browser.claudeNativeHost && cfg.claudePackage != null) {
      "com.anthropic.claude_browser_extension" =
        pkgs.writeText "com.anthropic.claude_browser_extension.json" (builtins.toJSON {
          name = "com.anthropic.claude_browser_extension";
          description = "Claude Browser Extension Native Host";
          path = "${cfg.claudePackage}/lib/claude-desktop/resources/chrome-native-host";
          type = "stdio";
          allowed_origins = map (id: "chrome-extension://${id}/") cfg.browser.claudeExtensionIds;
        });
    }
    // cfg.browser.nativeMessagingHosts;

  browserArgs = [
    "--user-data-dir=\"$data/chrome-data\""
    "--ozone-platform=wayland"
    "--password-store=${if cfg.keyring.enable then "gnome-libsecret" else "basic"}"
    "--no-first-run"
    "--no-default-browser-check"
  ] ++ map lib.escapeShellArg cfg.browser.extraArgs
    ++ lib.optional (cfg.browser.startUrl != null) (lib.escapeShellArg cfg.browser.startUrl);

  # Runs inside sway (sway's exec): WAYLAND_DISPLAY and SWAYSOCK are sway's,
  # DBUS_SESSION_BUS_ADDRESS is the private bus.
  session = pkgs.writeShellApplication {
    name = "claude-extra-display-session";
    runtimeInputs = [ pkgs.coreutils pkgs.dbus ] ++ lib.optional cfg.vnc.enable cfg.vnc.package;
    text = ''
      ln -sfn "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR/${cfg.socketName}"
      # Services the private bus starts on demand (portals) run on this display.
      dbus-update-activation-environment WAYLAND_DISPLAY SWAYSOCK XDG_CURRENT_DESKTOP XDG_SESSION_TYPE || true

      # Restart a program when it exits, so the display stays usable after the
      # browser or the VNC server is closed or crashes.
      keep() { while :; do "$@" || true; sleep 2; done; }

      ${lib.optionalString (cfg.vnc.enable && !cfg.vnc.unixSocket) ''
        # wayvnc's control socket goes to the run dir, not $XDG_RUNTIME_DIR/wayvncctl
        # (where a wayvnc on the user's own desktop keeps its). A stale one from
        # a crashed run is removed before each start.
        vnc() { rm -f "$XDG_RUNTIME_DIR/${runSub}/wayvncctl"; wayvnc -S "$XDG_RUNTIME_DIR/${runSub}/wayvncctl" ${lib.escapeShellArg cfg.vnc.address} ${toString cfg.vnc.port}; }
        keep vnc &
      ''}
      ${lib.optionalString (cfg.vnc.enable && cfg.vnc.unixSocket) ''
        # In the 0700 runtime subdirectory: only the user can connect. Stale
        # sockets from a crashed run are removed before each start; the control
        # socket stays off $XDG_RUNTIME_DIR/wayvncctl (see above).
        vnc() { rm -f "$XDG_RUNTIME_DIR/${runSub}/vnc.sock" "$XDG_RUNTIME_DIR/${runSub}/wayvncctl"; wayvnc -S "$XDG_RUNTIME_DIR/${runSub}/wayvncctl" --unix-socket "$XDG_RUNTIME_DIR/${runSub}/vnc.sock"; }
        keep vnc &
      ''}
      ${lib.optionalString cfg.browser.enable ''
        data="$HOME/${cfg.dataDir}"
        mkdir -p "$data/chrome-data/NativeMessagingHosts"
        ${lib.concatStrings (lib.mapAttrsToList (name: file: ''
          ln -sfn ${lib.escapeShellArg "${file}"} "$data/chrome-data/NativeMessagingHosts/"${lib.escapeShellArg "${name}.json"}
        '') hostManifests)}
        keep ${cfg.browser.executable} ${lib.concatStringsSep " " browserArgs} &
      ''}
      ${lib.concatMapStrings (cmd: ''
        sh -c ${lib.escapeShellArg cmd} &
      '') cfg.autostart}
      wait
    '';
  };

  swayConfig = pkgs.writeText "claude-extra-display-sway.conf" ''
    output * mode --custom ${cfg.resolution}
    swaybg_command -
    xwayland ${if cfg.xwayland then "enable" else "disable"}
    ${cfg.extraSwayConfig}
    exec ${lib.getExe session}
  '';

  start = pkgs.writeShellApplication {
    name = "claude-extra-display";
    # bash: sway runs its exec lines through `sh -c` from PATH, which a NixOS
    # user unit does not have.
    runtimeInputs = [ pkgs.coreutils pkgs.bash pkgs.dbus cfg.swayPackage config.systemd.package ]
      ++ lib.optional cfg.keyring.enable pkgs.gnome-keyring;
    text = ''
      : "''${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is not set}"
      data="$HOME/${cfg.dataDir}"
      run="$XDG_RUNTIME_DIR/${runSub}"
      mkdir -p "$data" "$run"
      chmod 700 "$data" "$run"

      # The user manager often carries the desktop session's variables (they
      # are imported at login). Display 2 must not see the user's own display.
      unset WAYLAND_DISPLAY WAYLAND_SOCKET DISPLAY XAUTHORITY SWAYSOCK I3SOCK \
        NIRI_SOCKET HYPRLAND_INSTANCE_SIGNATURE DESKTOP_STARTUP_ID XDG_ACTIVATION_TOKEN
      export XDG_CURRENT_DESKTOP=sway XDG_SESSION_DESKTOP=sway XDG_SESSION_TYPE=wayland

      # Private session bus at a fixed address, so Claude's background-display
      # setting can name it in its env.
      rm -f "$run/bus"
      dbus-daemon --session --nofork --nopidfile --address="unix:path=$run/bus" &
      for _ in $(seq 50); do [ -S "$run/bus" ] && break; sleep 0.1; done
      [ -S "$run/bus" ] || { echo "private D-Bus did not start" >&2; exit 1; }
      export DBUS_SESSION_BUS_ADDRESS="unix:path=$run/bus"

      ${lib.optionalString cfg.keyring.enable ''
        cred="$data/keyring.cred"
        if [ ! -e "$cred" ]; then
          if [ -e "$data/keyring/keyrings/login.keyring" ]; then
            echo "$data/keyring holds a keyring but $cred is missing: it cannot be unlocked." >&2
            echo "Restore $cred, or move $data/keyring away to start a new, empty keyring." >&2
            exit 78  # EX_CONFIG: needs a person, not a restart (RestartPreventExitStatus)
          fi
          if ! (umask 077; head -c 48 /dev/urandom | base64 -w0 \
            | systemd-creds encrypt --user --with-key=${cfg.keyring.withKey} \
                --name=claude-extra-keyring - "$cred.tmp"); then
            rm -f "$cred.tmp"
            echo "systemd-creds could not seal a keyring password with --with-key=${cfg.keyring.withKey} (host+tpm2 needs a TPM 2.0): set keyring.withKey = \"host\" on a machine without one, or keyring.enable = false." >&2
            exit 78
          fi
          mv "$cred.tmp" "$cred"
          echo "sealed a new keyring password in $cred (${cfg.keyring.withKey})"
        fi
        mkdir -p "$data/keyring" "$run/keyring"
        chmod 700 "$data/keyring" "$run/keyring"
        # Sealed for this machine, user and (host+tpm2) TPM: a new machine-id,
        # UID, host key or a cleared/replaced TPM makes it undecryptable for
        # good, but systemd-creds exits 1 for that and for a transient failure
        # (credentials service or TPM not ready at boot) alike: exit 1, and the
        # unit retries with a growing delay.
        if ! pw=$(systemd-creds decrypt --user --name=claude-extra-keyring "$cred" -); then
          echo "systemd-creds could not decrypt $cred (retrying). If it keeps failing it was sealed for another machine, user, host key or TPM:" >&2
          echo "move $cred and $data/keyring away to start a new, empty keyring." >&2
          exit 1
        fi
        printf '%s' "$pw" | XDG_DATA_HOME="$data/keyring" gnome-keyring-daemon --unlock \
            --components=secrets --control-directory="$run/keyring" >/dev/null
        unset pw
        # The daemon's parent returns before the child has unlocked the keyring
        # and claimed org.freedesktop.secrets: wait for the name first, so the
        # read below sees this keyring and cannot bus-activate a second one.
        owned=
        for _ in $(seq 100); do
          if [ "$(busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus \
            NameHasOwner s org.freedesktop.secrets 2>/dev/null || true)" = "b true" ]; then owned=1; break; fi
          sleep 0.1
        done
        if [ -z "$owned" ]; then
          echo "the display's keyring did not claim org.freedesktop.secrets within 10 s" >&2
          exit 1
        fi
        locked=$(busctl --user --auto-start=no get-property org.freedesktop.secrets \
          /org/freedesktop/secrets/collection/login org.freedesktop.Secret.Collection Locked 2>&1 || true)
        if [ "$locked" = "b true" ]; then
          # The keyring answered: still locked, so the password is wrong.
          echo "the display's keyring did not unlock with the password in $cred." >&2
          echo "If $cred does not belong to $data/keyring, move both away to start a new, empty keyring." >&2
          exit 78
        elif [ "$locked" != "b false" ]; then
          echo "could not read the display's keyring state (retrying): $locked" >&2
          exit 1
        fi
      ''}

      export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=${cfg.renderer}
      exec sway -c ${swayConfig}
    '';
  };
in
{
  options.programs.claude-desktop-extra.backgroundDisplay = {
    enable = mkEnableOption ''
      a headless sway display for one user, run as a systemd user service:
      display 2 for Computer Use on a background display, with a browser for
      Claude in Chrome and optionally a VNC server to look at it
    '';

    user = mkOption {
      type = types.str;
      example = "alice";
      description = ''
        The account the display runs for. The user unit is skipped for every
        other account. With {option}`linger` on it must be declared in
        {option}`users.users` (lingering is set there).
      '';
    };

    linger = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Enable lingering for {option}`user`, so the user manager, and with it the
        display, starts at boot and keeps running without a login. Sets
        `users.users.<user>.linger`, so the user must be declared there.
        Off: the module leaves lingering alone and the display starts at login.
      '';
    };

    dataDir = mkOption {
      # Relative, safe characters only: no leading "/", no "." or ".."
      # component (it is interpolated into the scripts and chmod'ed 700).
      type = types.strMatching "(\\.?[A-Za-z0-9_+-][A-Za-z0-9._+-]*)(/\\.?[A-Za-z0-9_+-][A-Za-z0-9._+-]*)*";
      default = ".claude-extra";
      description = ''
        State directory, relative to the user's home: chrome-data/, keyring/,
        keyring.cred. Path components of letters, digits and `._+-`, separated
        by `/`; no leading `/` and no `.` or `..` component.
      '';
    };

    socketName = mkOption {
      type = types.strMatching "wayland-[A-Za-z0-9._-]{1,64}";
      default = "wayland-claude-extra";
      description = ''
        Stable name of the display's Wayland socket in $XDG_RUNTIME_DIR (a
        symlink to sway's own wayland-N). Choose it in Settings -> Extra ->
        Cowork (Linux) -> Computer Use on a background display.
      '';
    };

    resolution = mkOption {
      type = types.strMatching "[0-9]+x[0-9]+";
      default = "1920x1080";
      description = "Size of the headless output.";
    };

    renderer = mkOption {
      type = types.enum [ "pixman" "gles2" "vulkan" ];
      default = "pixman";
      description = "wlroots renderer. pixman needs no GPU; the others need a render node the user can open.";
    };

    xwayland = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Run XWayland on the display. Off by default: X apps would get a DISPLAY
        Claude cannot tell apart from the desktop's own (see the background-display
        limits); turn it on only for apps that need X and pass that DISPLAY in
        the setting's env.
      '';
    };

    swayPackage = mkOption {
      type = types.package;
      default = pkgs.sway;
      defaultText = lib.literalExpression "pkgs.sway";
      description = "The sway package.";
    };

    claudePackage = mkOption {
      type = types.nullOr types.package;
      default = self.packages.${system}.claude-desktop or null;
      defaultText = lib.literalExpression "claude-desktop-extra.packages.\${system}.claude-desktop";
      description = "Package whose chrome-native-host the browser's Claude in Chrome manifest points to.";
    };

    keyring = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Run a gnome-keyring on the display's private bus, unlocked at start with a
          random password sealed by systemd-creds, for the browser's cookie and
          password encryption key. The sealed password is created on first start in
          ~/<dataDir>/keyring.cred. Off: the browser uses --password-store=basic, a
          fixed, publicly known key.
        '';
      };
      withKey = mkOption {
        type = types.enum [ "host+tpm2" "host" "auto" ];
        default = "host+tpm2";
        description = ''
          Key the password is sealed with (systemd-creds --with-key, user scope).
          host+tpm2 needs a TPM 2.0 and fails without one rather than silently
          falling back: the unit then stops (exit 78) with a journal line, and
          "host" is the setting for such a machine (its key is
          /var/lib/systemd/credential.secret on the root file system, so it
          protects the keyring as well as that disk's encryption does). The
          decryption runs in systemd, so the user needs no access to /dev/tpmrm0.
        '';
      };
    };

    vnc = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Run wayvnc on the display, for signing in to sites and watching Claude.
          wayvnc runs WITHOUT authentication: on a TCP address every local
          account (other users, services, host-network containers) can connect
          and drive the display - an unlocked keyring and a signed-in browser.
          Use it on a single-user machine, set {option}`vnc.unixSocket` (only
          the user can connect), or keep it off and turn it on while you sign in.
        '';
      };
      unixSocket = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Listen on the Unix socket $XDG_RUNTIME_DIR/claude-extra/vnc.sock
          instead of {option}`vnc.address`:{option}`vnc.port`. Its directory
          is private to the user, so no other account can connect. Reach it
          with a viewer that takes a socket path, or over SSH:
          ssh -L 5910:/run/user/<uid>/claude-extra/vnc.sock host.
        '';
      };
      package = mkOption {
        type = types.package;
        default = pkgs.wayvnc;
        defaultText = lib.literalExpression "pkgs.wayvnc";
        description = "The wayvnc package.";
      };
      address = mkOption {
        type = types.str;
        default = "127.0.0.1";
        description = ''
          Address wayvnc listens on. It runs without authentication: keep it on
          localhost and reach it over SSH (ssh -L 5910:127.0.0.1:5910 host).
          Even on localhost every local account can connect (see
          {option}`vnc.enable`); any other address warns at build time.
        '';
      };
      port = mkOption {
        type = types.port;
        default = 5910;
        description = "Port wayvnc listens on.";
      };
    };

    browser = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Start a browser with its own profile on the display, restarted when it exits.";
      };
      package = mkOption {
        type = types.package;
        default = pkgs.chromium;
        defaultText = lib.literalExpression "pkgs.chromium";
        example = lib.literalExpression "pkgs.google-chrome";
        description = "A Chromium-family browser (Chromium, Chrome, Brave, ...).";
      };
      executable = mkOption {
        type = types.str;
        default = lib.getExe cfg.browser.package;
        defaultText = lib.literalExpression "lib.getExe browser.package";
        description = "Command that starts the browser; set it for a wrapper or when mainProgram is not the browser.";
      };
      extraArgs = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Extra browser arguments.";
      };
      startUrl = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Page opened at start.";
      };
      claudeNativeHost = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Link the Claude in Chrome native-messaging manifest into the browser's
          profile (a separate user-data-dir reads manifests from its own
          NativeMessagingHosts/). Claude Desktop on the user's desktop finds the
          browser through the host's socket in /tmp.
        '';
      };
      claudeExtensionIds = mkOption {
        type = types.listOf types.str;
        default = [
          "dihbgbndebgnbjfmelmegjepbnkhlgni"
          "fcoeoabgfenejglbffodgkkbkcdhcgfn"
          "dngcpimnedloihjnnfngkgjoidhnaolf"
        ];
        description = "Extension IDs allowed to start the Claude native host (as Claude Desktop writes them, v4.23118).";
      };
      nativeMessagingHosts = mkOption {
        type = types.attrsOf types.path;
        default = { };
        example = lib.literalExpression ''{ "com.example.host" = ./com.example.host.json; }'';
        description = "More native-messaging manifests to link into the profile, by host name.";
      };
    };

    autostart = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "foot" ];
      description = "Shell commands started once on the display (not restarted).";
    };

    extraSwayConfig = mkOption {
      type = types.lines;
      default = "";
      description = "Lines added to the generated sway config.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !(cfg.browser.enable && cfg.browser.claudeNativeHost) || cfg.claudePackage != null;
        message = "programs.claude-desktop-extra.backgroundDisplay: no claude-desktop package for ${system}; set claudePackage or browser.claudeNativeHost = false.";
      }
    ];

    warnings = lib.optional (cfg.vnc.enable && !cfg.vnc.unixSocket
        && !(builtins.match "127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}" cfg.vnc.address != null
             || builtins.elem cfg.vnc.address [ "::1" "[::1]" "localhost" ]))
      "programs.claude-desktop-extra.backgroundDisplay: wayvnc listens on ${cfg.vnc.address}:${toString cfg.vnc.port} without authentication; anyone who can reach that address can drive the display and its signed-in browser.";

    # Only when lingering is on: defining users.users.<user> at all would
    # create the user entry (and fail nixpkgs' isNormalUser/isSystemUser
    # assertion for an account not declared in this configuration).
    users.users = lib.mkIf cfg.linger { ${cfg.user}.linger = true; };

    # Computer Use reads and writes display 2's clipboard with wl-copy/wl-paste.
    environment.systemPackages = [ pkgs.wl-clipboard ];

    systemd.user.services.claude-extra-display = {
      description = "Claude Desktop Extra background display (headless sway)";
      wantedBy = [ "default.target" ];
      unitConfig.ConditionUser = cfg.user;
      serviceConfig = {
        ExecStart = lib.getExe start;
        ExecStopPost = "${pkgs.coreutils}/bin/rm -f %t/${cfg.socketName} %t/${runSub}/bus %t/${runSub}/vnc.sock %t/${runSub}/wayvncctl";
        Restart = "on-failure";
        RestartPreventExitStatus = 78;
        # Keep trying, slowly: 5 s after the first failure, growing over 10
        # restarts to 5 min, so a slow boot recovers and a lasting failure
        # does not spin. No start limit (it would give up for good).
        RestartSec = 5;
        RestartSteps = 10;
        RestartMaxDelaySec = 300;
      };
    };
  };
}
