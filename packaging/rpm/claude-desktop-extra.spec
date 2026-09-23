%define _build_id_links none
%global debug_package %{nil}

# The bundled tree (Electron runtime, CU bridges, virtiofsd, node-pty) must not
# feed rpm's automatic ELF dependency generator: the gnome/kwin bridges carry a
# deliberate glibc-2.39 floor (their sessions only exist on Fedora 40+ / KDE
# 6.6+ distros), and letting the scanner harvest their symbols makes the whole
# package uninstallable on RHEL 9 (glibc 2.34), where those bridges simply
# never run. Runtime deps are declared by hand below, mirroring the official
# .deb's Depends - exactly how our .deb packaging works. The provides filter
# keeps bundled sonames (libffmpeg.so, ...) from leaking into the repo either.
%global __requires_exclude_from ^/usr/lib/claude-desktop/.*$
%global __provides_exclude_from ^/usr/lib/claude-desktop/.*$

Name:           claude-desktop-extra
Version:        %{pkg_version}
Release:        %{?pkg_release}%{!?pkg_release:1}
Summary:        Claude Desktop for Linux with extra features (Computer Use, themes, profiles)

# The project was renamed from claude-desktop-bin to claude-desktop-extra
# (2026-07). Obsoletes lets dnf migrate existing installs automatically;
# Provides keeps anything that referenced the old name resolvable.
Obsoletes:      claude-desktop-bin <= 1.24012.9
Provides:       claude-desktop-bin = %{version}-%{release}
# Anthropic's own claude-desktop package (its .deb today; its postinst hints at
# an RPM) installs the same /usr/lib/claude-desktop tree. Refuse to co-install;
# switch with `dnf swap claude-desktop claude-desktop-extra`.
Conflicts:      claude-desktop

License:        Proprietary
URL:            https://claude.ai
# The tarball ships the official Claude Desktop tree VERBATIM under
# claude-desktop/ (Electron runtime + resources/app.asar already patched + our CU
# bridges under resources/), extracted from the official Claude Desktop Linux
# .deb. There is no separate Electron zip source anymore.
Source0:        %{pkg_source}

ExclusiveArch:  x86_64 aarch64

Requires:       gtk3
Requires:       nss
Requires:       libXScrnSaver
Requires:       libXtst
Requires:       at-spi2-core
Requires:       libdrm
Requires:       mesa-libgbm
Requires:       alsa-lib
Requires:       libnotify
# libsecret is dlopened by Chromium's os_crypt for keyring credential storage —
# rpm's automatic soname scan does NOT catch dlopen, so it must be explicit.
# xdg-utils (xdg-open) and xdg-desktop-portal mirror the official .deb's Depends.
Requires:       libsecret
Requires:       xdg-utils
Requires:       xdg-desktop-portal
# Cowork agent workspace VM. Cowork runs the agent workspace in a lightweight
# KVM VM, which needs QEMU + UEFI firmware + virtiofsd on the host. Kept soft
# (Recommends) to mirror the official Claude Desktop .deb, which lists these in
# Recommends too — so dnf pulls them by default but they never block install on
# minimal/headless/KVM-less hosts. /dev/kvm access still needs the user in the
# `kvm` group (not a package's job).
#
# QEMU package name differs between Fedora and RHEL: Fedora splits per-arch
# (qemu-system-x86 / qemu-system-aarch64); RHEL ships the emulator in qemu-kvm
# (the Fedora names don't exist there). Firmware names are identical on both.
%if 0%{?rhel}
Recommends:     qemu-kvm
%else
%ifarch x86_64
Recommends:     qemu-system-x86
%endif
%ifarch aarch64
Recommends:     qemu-system-aarch64
%endif
%endif
%ifarch x86_64
Recommends:     edk2-ovmf
%endif
%ifarch aarch64
Recommends:     edk2-aarch64
%endif
Recommends:     virtiofsd
# Project detection (detectedProjects source) — without it, periodic ENOENT
# errors spam ~/.config/Claude/logs/main.log and detected-projects features
# don't surface. Soft dep so the app still installs without it.
Recommends:     sqlite
# Computer Use is fully first-party now: bundled x11-bridge (X11/XWayland),
# wlroots-bridge (Sway/Hyprland/Niri), gnome-portal-bridge (GNOME Wayland) and
# kwin-portal-bridge (KDE Plasma 6.6+). Remaining Suggests cover only the
# residual paths:
# - ImageMagick: screenshot crop for the KDE-without-kwin-bridge spectacle tier
# - ydotool: input on exotic Wayland compositors (non-wlroots/GNOME/KDE;
#   requires ydotoold daemon)
Suggests:       ImageMagick
Suggests:       ydotool
# Faster Quick Entry toggle via socket (~2ms vs ~25ms python3 — not required)
Suggests:       socat
# Hardware Buddy (Nibblet BLE pet): the bluez daemon is what Web Bluetooth talks
# to; without it running, the in-app device scan finds nothing. Soft dep.
Suggests:       bluez
# MCP servers requiring system Node.js
Suggests:       nodejs
# Credential storage backend for libsecret. Suggests (not Recommends) because
# Fedora/RHEL GNOME ships gnome-keyring and KDE ships kwallet already — rpm weak
# deps have no "A | B" alternation like dpkg, and Recommends would force
# gnome-keyring onto KDE installs.
Suggests:       gnome-keyring
# GNOME Shell search provider (installed below) runs under gjs. GNOME Shell
# already depends on it; Suggests keeps it off KDE and headless installs.
Suggests:       gjs

%description
Anthropic's official Claude Desktop for Linux, repackaged for distros the
official build does not ship (Fedora, RHEL, and more), with extra Linux
features on top: Computer Use input/screenshot backends for X11 and Wayland,
custom themes with the "Extra" settings hub, multi-profile support, and a
Quick Entry launcher.

Note: This is an unofficial community build. Requires an Anthropic account.

%prep
# Extract tarball (ships the official Claude Desktop tree verbatim under
# claude-desktop/, with our patched resources/app.asar + CU bridges)
mkdir -p tarball
tar -xzf %{SOURCE0} -C tarball

%install
rm -rf %{buildroot}

# Install the official Claude Desktop tree VERBATIM (from the tarball's
# claude-desktop/ dir): the Electron runtime, resources/app.asar (our patched
# build) + app.asar.unpacked + upstream app resources + our CU bridges. The tree
# is verbatim except the entrypoint is ALREADY renamed to "claude", app.asar is
# our patched build, and the bridges are added. Electron auto-loads the
# exe-adjacent resources/app.asar (OnlyLoadAppFromAsar fuse), so no resources/
# remapping and no binary rename are needed here.
mkdir -p %{buildroot}/usr/lib/claude-desktop
cp -a tarball/claude-desktop/* %{buildroot}/usr/lib/claude-desktop/

# Install launcher (full launcher from tarball with Wayland/X11 detection,
# GPU fallback, SingletonLock cleanup, and logging)
mkdir -p %{buildroot}/usr/bin
install -m755 tarball/launcher/claude-desktop %{buildroot}/usr/bin/claude-desktop

# Upstream license notice (tarball root, from the official .deb's usr/share/doc;
# placed there by build-patched-tarball.sh). Hard requirement — a missing file
# means an outdated (pre-2026-07) tarball; rebuild it first.
install -Dm644 tarball/copyright %{buildroot}/usr/share/licenses/%{name}/copyright

# Install desktop file.
# Filename is "com.anthropic.Claude.desktop" to ride upstream's app identity
# "com.anthropic.Claude" (Chromium's GetXdgAppId() reads the app's desktopName,
# now "com.anthropic.Claude.desktop", and strips ".desktop"); we no longer pin it.
# On native Wayland there is no WM_CLASS, so KWin/GNOME match by app_id; a mismatched
# basename gives a generic icon + Alt+Tab duplicate (issue #148). StartupWMClass fixes X11.
# Content mirrors the official Claude Desktop .deb.
mkdir -p %{buildroot}/usr/share/applications
cat > %{buildroot}/usr/share/applications/com.anthropic.Claude.desktop << 'DESKTOP'
[Desktop Entry]
Name=Claude
Comment=Desktop application for Claude.ai
GenericName=AI Assistant
Keywords=AI;Chat;Assistant;Claude;Code;LLM;
Exec=claude-desktop %U
Icon=claude-desktop
Type=Application
StartupNotify=true
StartupWMClass=com.anthropic.Claude
# second-instance just focuses mainWindow; suppress GNOME's default "New Window" item
SingleMainWindow=true
Categories=Utility;Development;
MimeType=x-scheme-handler/claude;
Actions=NewChat;NewCode;

[Desktop Action NewChat]
Name=New chat
Exec=claude-desktop claude://claude.ai/new

[Desktop Action NewCode]
Name=New Claude Code session
Exec=claude-desktop claude://code/new
DESKTOP

# Install every icon size the tarball carries
mkdir -p %{buildroot}/usr/share/icons
if [ -d tarball/icons/hicolor ]; then
    cp -a tarball/icons/hicolor %{buildroot}/usr/share/icons/
fi

# GNOME Shell search provider. Upstream's postinst copies these two files out of
# resources/gnome-search-provider/ at configure time; we ship the same bytes as
# package files so rpm owns them. The .service Exec runs /usr/bin/gjs on
# searchProvider.js under /usr/lib/claude-desktop, which is our prefix too.
SP_SRC=%{buildroot}/usr/lib/claude-desktop/resources/gnome-search-provider
for f in com.anthropic.Claude.search-provider.ini com.anthropic.Claude.SearchProvider.service searchProvider.js; do
    if [ ! -f "$SP_SRC/$f" ]; then
        echo "ERROR: resources/gnome-search-provider/$f missing - upstream layout changed; re-audit" >&2
        exit 1
    fi
done
if ! grep -qx 'Exec=/usr/bin/gjs -m /usr/lib/claude-desktop/resources/gnome-search-provider/searchProvider.js' \
        "$SP_SRC/com.anthropic.Claude.SearchProvider.service"; then
    echo "ERROR: search provider .service Exec line changed upstream - re-audit" >&2
    exit 1
fi
install -pDm644 "$SP_SRC/com.anthropic.Claude.search-provider.ini" \
    %{buildroot}/usr/share/gnome-shell/search-providers/com.anthropic.Claude.search-provider.ini
install -pDm644 "$SP_SRC/com.anthropic.Claude.SearchProvider.service" \
    %{buildroot}/usr/share/dbus-1/services/com.anthropic.Claude.SearchProvider.service

%post
# Ensure chrome-sandbox has SUID root (required by Chromium's setuid sandbox)
if [ -f /usr/lib/claude-desktop/chrome-sandbox ]; then
    chown root:root /usr/lib/claude-desktop/chrome-sandbox
    chmod 4755 /usr/lib/claude-desktop/chrome-sandbox
fi
# AppArmor userns profile (mirrors the official .deb). Most RPM distros use
# SELinux, where /etc/apparmor.d/abi/4.0 is absent and this is a no-op; it only
# fires on AppArmor 4.0 systems (e.g. openSUSE) where Chromium's namespace
# sandbox needs the unconfined-userns allowlist.
if [ -f /etc/apparmor.d/abi/4.0 ]; then
    PROFILE="/etc/apparmor.d/claude-desktop"
    rm -f "$PROFILE"
    cat > "$PROFILE" <<PROF
abi <abi/4.0>,
include <tunables/global>

profile claude-desktop /usr/lib/claude-desktop/claude flags=(unconfined) {
  userns,

  include if exists <local/claude-desktop>
}
PROF
    chmod 0644 "$PROFILE"
    if command -v aa-enabled &>/dev/null && aa-enabled --quiet 2>/dev/null; then
        apparmor_parser -r -W -T "$PROFILE" || true
    fi
fi
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache /usr/share/icons/hicolor || true
fi
# Ensure repo config has metadata_expire for timely updates
REPO_FILE="/etc/yum.repos.d/claude-desktop.repo"
if [ -f "$REPO_FILE" ] && ! grep -q '^metadata_expire=' "$REPO_FILE"; then
    echo 'metadata_expire=300' >> "$REPO_FILE"
fi
# Rename migration (retire with the transition window): point a repo config
# still on the pre-rename Pages URL (baseurl + gpgkey) at the new repository.
# Guarded and idempotent - must never fail the rpm transaction.
if [ -f "$REPO_FILE" ] && grep -q 'patrickjaja.github.io/claude-desktop-bin/' "$REPO_FILE" 2>/dev/null; then
    sed -i 's|patrickjaja.github.io/claude-desktop-bin/|patrickjaja.github.io/claude-desktop-extra/|g' "$REPO_FILE" 2>/dev/null || :
    echo "claude-desktop-extra: migrated DNF repo config to the new repository URL" || :
fi

%postun
# Remove the AppArmor profile on full uninstall ($1 == 0), not on upgrade.
if [ "$1" = "0" ] && [ -f /etc/apparmor.d/claude-desktop ]; then
    if command -v aa-enabled &>/dev/null && aa-enabled --quiet 2>/dev/null; then
        apparmor_parser -R /etc/apparmor.d/claude-desktop || true
    fi
    rm -f /etc/apparmor.d/claude-desktop
fi
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache /usr/share/icons/hicolor || true
fi

%posttrans
# When a transaction swaps out Anthropic's claude-desktop package, its postun
# scriptlet runs after our post scriptlet and can delete the search provider
# paths we own. rpm runs posttrans last, so restore the shipped bytes from
# resources/.
SP_SRC=/usr/lib/claude-desktop/resources/gnome-search-provider
for pair in \
    "com.anthropic.Claude.search-provider.ini:/usr/share/gnome-shell/search-providers" \
    "com.anthropic.Claude.SearchProvider.service:/usr/share/dbus-1/services"; do
    f="${pair%%%%:*}"; d="${pair#*:}"
    if [ ! -e "$d/$f" ] && [ -f "$SP_SRC/$f" ]; then
        mkdir -p "$d" && cp -p "$SP_SRC/$f" "$d/$f" && chmod 0644 "$d/$f" || :
    fi
done
:

%files
# Upstream license notice, installed in %%install from the tarball root.
%license /usr/share/licenses/%{name}/copyright
/usr/lib/claude-desktop/
/usr/bin/claude-desktop
/usr/share/applications/com.anthropic.Claude.desktop
/usr/share/icons/hicolor/*/apps/claude-desktop.png
/usr/share/gnome-shell/search-providers/com.anthropic.Claude.search-provider.ini
/usr/share/dbus-1/services/com.anthropic.Claude.SearchProvider.service
