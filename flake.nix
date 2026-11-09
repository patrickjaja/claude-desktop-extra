{
  description = "Claude Desktop for Linux - unofficial package with extra features";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        packages = {
          claude-desktop = pkgs.callPackage ./packaging/nix/package.nix {
            # The official .deb ships on Electron 44 (see CHANGELOG / the deb's
            # usr/lib/claude-desktop/version). nixpkgs' `electron` alias lags a
            # major behind, so pin the one the bundle was built for. flake.lock pins
            # nixpkgs: when this moves to a new major, run `nix flake update` in the
            # same commit, or the locked nixpkgs may not have the attribute yet.
            electron = pkgs.electron_44;
            # Avoid pulling claude-code from nixpkgs — its npm tarball is
            # frequently yanked between releases, breaking the build.
            # Users can override: claude-desktop.override { claude-code = pkgs.claude-code; }
            claude-code = null;
          };
          default = self.packages.${system}.claude-desktop;
          # Alias under the new project name (claude-desktop-bin -> claude-desktop-extra
          # relaunch); both attrs resolve to the same package.
          claude-desktop-extra = self.packages.${system}.claude-desktop;
        };
      }
    ) // {
      # NixOS module. Both options are off by default.
      #
      # tpmAccess adds the udev rule that gives the user at the active local seat
      # access to /dev/tpmrm0, where Claude Desktop keeps its device identity key
      # (cloud Cowork and Dispatch only offer Computer Use to a device with that
      # key).
      #
      # kvmAccess adds the udev rule that gives the user at the active local seat
      # access to /dev/kvm and /dev/vhost-vsock, and loads vhost_vsock at boot,
      # so the local Cowork VM can start without joining the kvm group.
      #
      # The rules are read from this flake, so they do not depend on which
      # package version is installed.
      #   imports = [ claude-desktop-extra.nixosModules.default ];
      #   programs.claude-desktop-extra.tpmAccess.enable = true;
      #   programs.claude-desktop-extra.kvmAccess.enable = true;
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.claude-desktop-extra.tpmAccess;
          kvmCfg = config.programs.claude-desktop-extra.kvmAccess;
          rule = pkgs.runCommand "claude-desktop-extra-tpm-udev-rule" { } ''
            install -Dm644 ${./packaging/udev/70-claude-desktop-extra-tpm.rules} \
              $out/lib/udev/rules.d/70-claude-desktop-extra-tpm.rules
          '';
          kvmRule = pkgs.runCommand "claude-desktop-extra-kvm-udev-rule" { } ''
            install -Dm644 ${./packaging/udev/70-claude-desktop-extra-kvm.rules} \
              $out/lib/udev/rules.d/70-claude-desktop-extra-kvm.rules
          '';
        in
        {
          # programs.claude-desktop-extra.backgroundDisplay: a headless sway
          # display for Computer Use and Claude in Chrome (docs/nixos-background-display.md).
          imports = [ (import ./packaging/nix/background-display.nix { inherit self; }) ];

          options.programs.claude-desktop-extra.tpmAccess.enable = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Give read/write access to /dev/tpmrm0 (the TPM 2.0 kernel resource
              manager, never /dev/tpm0) through a udev uaccess rule, so Claude
              Desktop can keep its device identity key in the TPM. It applies to
              every account that logs in at this computer's screen (the active
              local seat), and any program such an account runs can then use the
              TPM, including clearing it (destroys TPM-sealed keys such as
              LUKS/systemd-cryptenroll or BitLocker keys), triggering its
              dictionary-attack lockout, or setting its owner or lockout
              password. If the TPM's lockout or owner authorization is empty,
              set one first (tpm2_changeauth -c lockout, -c owner).
            '';
          };
          options.programs.claude-desktop-extra.kvmAccess.enable = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Give read/write access to /dev/kvm and /dev/vhost-vsock through a
              udev uaccess rule, and load the vhost_vsock kernel module at boot,
              so the local Cowork VM (QEMU) can start without adding anyone to
              the kvm group. It applies to every account that logs in at this
              computer's screen (the active local seat), and any program such an
              account runs can then create KVM virtual machines and vhost-vsock
              host/guest sockets. Cloud Cowork does not need this.
            '';
          };
          config = lib.mkMerge [
            (lib.mkIf cfg.enable {
              services.udev.packages = [ rule ];
            })
            (lib.mkIf kvmCfg.enable {
              services.udev.packages = [ kvmRule ];
              boot.kernelModules = [ "vhost_vsock" ];
            })
          ];
        };
    };
}
