{ lib
, stdenvNoCC
, fetchurl
, electron
, libsecret          # dlopened by Chromium's os_crypt for keyring credential storage
, patchelf           # RPATH tripwire below
, makeWrapper
, makeDesktopItem
, copyDesktopItems
, imagemagick ? null    # Computer Use screenshot crop via convert - residual KDE-without-kwin-bridge spectacle tier only
# Computer Use is first-party now: the bundled STATIC bridges (x11-bridge for
# X11/XWayland, wlroots-bridge for Sway/Hyprland/Niri) run on NixOS as-is.
# The two glibc-DYNAMIC bridges (kwin-portal-bridge for KDE 6.6+,
# gnome-portal-bridge for GNOME Wayland) have a glibc mismatch on NixOS; pass a
# natively built gnome-portal-bridge below to enable GNOME Wayland CU.
, ydotool ? null        # input on exotic Wayland compositors ONLY (non-wlroots/GNOME/KDE; requires ydotoold daemon)
# Computer Use — KDE Plasma Wayland (bundled bridge has glibc mismatch on NixOS)
, spectacle ? null      # screenshot fallback (KDE Plasma on NixOS)
# Computer Use — GNOME Wayland: natively built gnome-portal-bridge
# (github.com/patrickjaja/gnome-bridge); sets GNOME_PORTAL_BRIDGE_BIN so the
# executor uses it instead of the bundled (glibc-mismatched) binary.
, gnome-portal-bridge ? null
, glib ? null              # gsettings (flat mouse acceleration)
# Claude Code CLI — required for Cowork, Dispatch, and Code integration
, claude-code ? null    # auto-resolved by callPackage if in nixpkgs
# Cowork agent workspace VM (also requires /dev/kvm + kvm group membership).
# The app's capability probe needs THREE tools (issue #177):
#   - qemu-system-x86_64 on PATH            -> qemu (--prefix PATH)
#   - OVMF UEFI CODE+VARS firmware          -> OVMF (CLAUDE_OVMF_CODE_PATH)
#   - a system virtiofsd                    -> virtiofsd (CLAUDE_VIRTIOFSD_PATH)
# The bundled resources/virtiofsd does NOT count: the probe only uses the
# bundled copy on Ubuntu 22.x (os-release gate), and NixOS can't exec it anyway
# (foreign ld-linux interpreter). The CLAUDE_* env vars are honored by our
# fix_cowork_firmware_paths_linux patch from release 1.18286.0 on; on older
# pinned tarballs they are ignored and the workarounds are: add `pkgs.virtiofsd`
# to `environment.systemPackages` (the probe checks the resulting
# /run/current-system/sw/bin/virtiofsd, PR #178) and expose OVMF at a probed
# /usr/share path via systemd.tmpfiles / an activation-script symlink.
, qemu ? null           # provides qemu-system-x86_64 for the Cowork VM
, virtiofsd ? null      # system virtiofsd (bundled one is Ubuntu-22-only)
, OVMF ? null           # UEFI firmware; OVMF.fd output must ship CODE+VARS pair
, socat ? null          # faster Quick Entry toggle (~2ms vs ~25ms python3)
, nodejs ? null         # third-party MCP servers
# Extra PATH entries for binaries not packaged in Nix (e.g. npm global, nvm)
, extraSessionPaths ? []
}:

let
  # Updated automatically by CI (build-and-release.yml) on each release.
  version = "1.46388.2"; # pkgver: always the upstream Claude Desktop version
  pkgrel = "2"; # Arch-style release counter: bumped on re-releases of the same upstream version, reset to 1 on version bumps
  hash = "sha256-U5H6e315Yv7YSQOn/tsmv5z4522ATLMyR/4ytYKP3cc=";
  # Every release publishes under its own tag (v<version> for pkgrel 1,
  # v<version>-<pkgrel> for re-releases) and its assets are never overwritten
  # afterwards, so this URL is immutable and a pinned flake.lock keeps fetching
  # byte-identical content forever (issue #214).
  releaseTag = if pkgrel == "1" then "v${version}" else "v${version}-${pkgrel}";
  # The release tarball ships the official Claude Desktop tree verbatim under
  # claude-desktop/ (Electron runtime + our patched resources/app.asar + CU
  # bridges), extracted from Anthropic's Linux .deb. On NixOS, however, that
  # glibc-linked Electron binary won't run without autoPatchelf + a runtime
  # closure, so we keep using the nixpkgs `electron` derivation (idiomatic,
  # sandbox-correct) and DISCARD the tarball's bundled Electron runtime. We
  # consume only the tarball's claude-desktop/resources/ (our patched app.asar +
  # upstream app resources + bridges) and merge it into the nixpkgs electron dist
  # so Electron finds the exe-adjacent resources/app.asar (OnlyLoadAppFromAsar
  # fuse). Pin `electron` to the major version the app expects (Electron 42; see
  # the tarball's claude-desktop/version) via an override at call site if your
  # nixpkgs default diverges.
in
stdenvNoCC.mkDerivation {
  pname = "claude-desktop-extra";
  inherit version;

  src = fetchurl {
    url = "https://github.com/patrickjaja/claude-desktop-extra/releases/download/${releaseTag}/claude-desktop-${version}-linux.tar.gz";
    inherit hash;
  };

  sourceRoot = ".";

  # patchelf comes from the Linux stdenv anyway; declared explicitly because the
  # tripwire below pipes it into grep, so a missing binary would surface as
  # grep's exit status - i.e. the tripwire firing with the wrong explanation.
  nativeBuildInputs = [ makeWrapper copyDesktopItems patchelf ];

  # Keep the RPATH nixpkgs' electron deliberately baked into its binary. Chromium
  # dlopens several libraries instead of linking them, so they never appear in
  # DT_NEEDED: libsecret (os_crypt keyring), libnotify, pipewire, libpulseaudio,
  # speechd. nixpkgs covers them with `patchelf --add-rpath` (source-built
  # electron) / `--set-rpath` (electron-bin), and that RPATH rides along when we
  # copy the dist below. But stdenv's patchelf fixup hook then runs
  # `patchelf --shrink-rpath`, which drops exactly the entries no DT_NEEDED
  # library lives in - i.e. all five - so they leave the binary's RUNPATH and
  # dlopen can no longer find them. With the source-built electron that also
  # drops their store references and the libs leave the closure outright (the
  # reporter measured zero libsecret references); with electron-bin the closure
  # keeps them via the retained ${electron}/libexec/electron entry, but the
  # RUNPATH is just as gone. Either way safeStorage.isEncryptionAvailable() was
  # false forever and sign-in never persisted across restarts (issue #206).
  # Nothing else in this output needs shrinking - the CU bridges are static musl
  # (no .dynamic at all) or foreign glibc binaries carrying no store RPATH.
  dontPatchELF = true;

  # Tripwire. dontPatchELF only helps while nixpkgs' electron actually ships the
  # dlopen-only libs in its RPATH. If that ever stops, libsecret becomes
  # unreachable again and sign-in silently stops persisting - and libnotify,
  # pipewire, libpulseaudio and speechd have no LD_LIBRARY_PATH backstop at all.
  # Fail the build instead of shipping that. patchelf is on PATH from the Linux
  # stdenv even here (dontPatchELF disables its fixup hook, not the tool).
  # It reports success explicitly: a silent pass is indistinguishable from the
  # check never running (a renamed attribute would be ignored, not an error), and
  # this is exactly the assertion whose absence caused #206 to go unnoticed.
  postFixup = ''
    if ! patchelf --print-rpath $out/lib/claude-desktop/claude | grep -q libsecret; then
      echo "ERROR: libsecret is not in the claude binary's RPATH." >&2
      echo "nixpkgs' electron no longer ships Chromium's dlopen-only libraries there;" >&2
      echo "re-audit packaging/nix/package.nix against issue #206. LD_LIBRARY_PATH below" >&2
      echo "still covers libsecret, but the other four dlopened libs do not have that." >&2
      exit 1
    fi
    echo "libsecret RPATH tripwire: OK (dlopen-only libs survived fixup)"
  '';

  # "name" becomes the .desktop filename. It is "com.anthropic.Claude" so the
  # installed file is com.anthropic.Claude.desktop, matching the app's *live*
  # app_id - Chromium's GetXdgAppId() reads the app's desktopName
  # ("com.anthropic.Claude.desktop" in
  # app.asar package.json), strips ".desktop", and ignores the binary basename
  # / --class / argv[0]. We now ride upstream's official "com.anthropic.Claude"
  # app identity, so the .desktop filename and startupWMClass match it (we no
  # longer pin our own "claude-desktop" identity). On native Wayland there is no
  # WM_CLASS, so KWin/GNOME match the window to its .desktop by app_id; if the
  # basename doesn't equal the app_id the dock icon is generic and Alt+Tab shows
  # a duplicate (issue #148). startupWMClass=com.anthropic.Claude fixes the
  # X11/XWayland path. The claude-desktop binary rename below is kept only as a
  # cosmetic argv[0] / scope hint; it does NOT set WM_CLASS. Content mirrors the
  # official Claude Desktop .deb.
  desktopItems = [
    (makeDesktopItem {
      name = "com.anthropic.Claude";
      desktopName = "Claude";
      genericName = "AI Assistant";
      comment = "Desktop application for Claude.ai";
      keywords = [ "AI" "Chat" "Assistant" "Claude" "Code" "LLM" ];
      exec = "claude-desktop %U";
      icon = "claude-desktop";
      categories = [ "Utility" "Development" ];
      mimeTypes = [ "x-scheme-handler/claude" ];
      startupNotify = true;
      startupWMClass = "com.anthropic.Claude";
      terminal = false;
      # second-instance just focuses mainWindow; suppress GNOME's "New Window" item
      singleMainWindow = true;
      actions = {
        NewChat = {
          name = "New chat";
          exec = "claude-desktop claude://claude.ai/new";
        };
        NewCode = {
          name = "New Claude Code session";
          exec = "claude-desktop claude://code/new";
        };
      };
    })
  ];

  installPhase = ''
    runHook preInstall

    # Materialise the nixpkgs Electron dist into $out/lib/claude-desktop/ with the
    # binary renamed to "claude" (cosmetic argv[0] / systemd-scope hint only; the
    # Wayland app_id / X11 WM_CLASS comes from the app's desktopName
    # "com.anthropic.Claude", not this basename - see startupWMClass above). The
    # tarball's own bundled Electron runtime is DISCARDED on NixOS (foreign
    # glibc); we use nixpkgs electron instead.
    mkdir -p $out/lib/claude-desktop
    cp -rL ${electron}/libexec/electron/. $out/lib/claude-desktop/
    # Store-copied files keep their read-only modes; make the tree writable so
    # the resources/ swap below (and the rename) can modify it.
    chmod -R u+w $out/lib/claude-desktop
    mv $out/lib/claude-desktop/electron $out/lib/claude-desktop/claude
    chmod +x $out/lib/claude-desktop/claude

    # Replace the electron dist's default resources/ (only default_app.asar) with
    # the tarball's claude-desktop/resources/ (our patched app.asar +
    # app.asar.unpacked + upstream app resources + CU bridges). Electron then
    # auto-loads the exe-adjacent resources/app.asar (OnlyLoadAppFromAsar fuse).
    # The rest of the tarball's claude-desktop/ tree (bundled Electron runtime) is
    # NOT used on Nix.
    rm -rf $out/lib/claude-desktop/resources
    cp -r claude-desktop/resources $out/lib/claude-desktop/resources

    # Install launcher script (handles --toggle, --install-gnome-hotkey, --diagnose
    # and all Wayland/X11 detection, GPU fallback, etc.)
    #
    # libsecret is also declared explicitly on LD_LIBRARY_PATH: dontPatchELF above
    # already keeps it reachable via the binary's RPATH, but this makes the
    # requirement visible the way every other packaging format states it
    # (PKGBUILD 'libsecret', deb libsecret-1-0, rpm Requires: libsecret) and keeps
    # credential storage working even if a future nixpkgs electron stops shipping
    # it in the RPATH. Suffixed, so it can never shadow a library for the app's
    # children (MCP servers, claude-code, qemu).
    mkdir -p $out/bin
    cp launcher/claude-desktop $out/lib/claude-desktop/launcher.sh
    chmod +x $out/lib/claude-desktop/launcher.sh
    makeWrapper $out/lib/claude-desktop/launcher.sh $out/bin/claude-desktop \
      --suffix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ libsecret ]} \
      --set CLAUDE_ELECTRON "$out/lib/claude-desktop/claude" \
      --set ELECTRON_OZONE_PLATFORM_HINT "auto" \
      --set ELECTRON_FORCE_IS_PACKAGED "true" \
      --set ELECTRON_USE_SYSTEM_TITLE_BAR "1" \
      ${lib.optionalString (imagemagick != null) "--prefix PATH : ${imagemagick}/bin"} \
      ${lib.optionalString (socat != null) "--prefix PATH : ${socat}/bin"} \
      ${lib.optionalString (ydotool != null) "--prefix PATH : ${ydotool}/bin"} \
      ${lib.optionalString (spectacle != null) "--prefix PATH : ${spectacle}/bin"} \
      ${lib.optionalString (gnome-portal-bridge != null) "--set-default GNOME_PORTAL_BRIDGE_BIN ${gnome-portal-bridge}/bin/gnome-portal-bridge"} \
      ${lib.optionalString (glib != null) "--prefix PATH : ${glib}/bin"} \
      ${lib.optionalString (nodejs != null) "--prefix PATH : ${nodejs}/bin"} \
      ${lib.optionalString (qemu != null) "--prefix PATH : ${qemu}/bin"} \
      ${lib.optionalString (virtiofsd != null) "--set-default CLAUDE_VIRTIOFSD_PATH ${virtiofsd}/bin/virtiofsd"} \
      ${lib.optionalString (OVMF != null) "--set-default CLAUDE_OVMF_CODE_PATH ${OVMF.fd}/FV/${if stdenvNoCC.hostPlatform.isAarch64 then "AAVMF_CODE.fd" else "OVMF_CODE.fd"}"} \
      ${lib.optionalString (claude-code != null && extraSessionPaths == []) "--prefix PATH : ${claude-code}/bin"} \
      ${lib.concatMapStringsSep " \\\n      " (p:
        let path = if builtins.isString p then p else "${p}/bin";
        in "--prefix PATH : ${path}"
      ) extraSessionPaths}

    # Install every icon size the tarball carries
    if [ -d icons/hicolor ]; then
      mkdir -p $out/share/icons
      cp -a icons/hicolor $out/share/icons/
    fi

    # Upstream license notice (tarball root, from the official .deb's
    # usr/share/doc). Guarded: pre-2026-07 release tarballs lack it, and the
    # flake may still pin one of those.
    if [ -f copyright ]; then
      install -Dm644 copyright $out/share/licenses/claude-desktop/copyright
    fi

    runHook postInstall
  '';

  meta = with lib; {
    description = "Claude AI Desktop Application for Linux";
    homepage = "https://claude.ai";
    license = licenses.unfree;
    platforms = [ "x86_64-linux" "aarch64-linux" ];
    maintainers = [ ];
    mainProgram = "claude-desktop";
  };
}
