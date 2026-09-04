# Claude Desktop for Linux

[![Claude Desktop](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/version-check.json)](https://claude.ai/download)
[![Build & Release](https://github.com/patrickjaja/claude-desktop-extra/actions/workflows/build-and-release.yml/badge.svg)](https://github.com/patrickjaja/claude-desktop-extra/actions/workflows/build-and-release.yml)
[![Website](https://img.shields.io/badge/Website-Landing_Page-a78bfa?logo=github)](https://patrickjaja.github.io/claude-desktop-extra/)
[![Reddit](https://img.shields.io/badge/Reddit-Discussion-FF4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/ClaudeAI/comments/1r871b0/claude_desktop_on_linux_chat_cowork_code/)

[![Pacman repo](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/pacman-repo.json)](https://github.com/patrickjaja/claude-desktop-extra#arch-linux--manjaro-pacman-repository)
[![APT repo](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/apt-repo.json)](https://github.com/patrickjaja/claude-desktop-extra#debian--ubuntu-apt-repository)
[![RPM repo](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/rpm-repo.json)](https://github.com/patrickjaja/claude-desktop-extra#fedora--rhel-dnf-repository)
[![AppImage](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/appimage.json)](https://github.com/patrickjaja/claude-desktop-extra#appimage-any-distro)
[![Nix flake](https://img.shields.io/endpoint?url=https://patrickjaja.github.io/claude-desktop-extra/badges/nix.json)](https://github.com/patrickjaja/claude-desktop-extra#nixos--nix)

**Anthropic's official Claude Desktop Linux build, repackaged for the distros Anthropic doesn't ship - plus Linux-only extras.**

Anthropic publishes an official Claude Desktop [Linux `.deb`](https://code.claude.com/docs/en/desktop-linux) (Ubuntu 22.04+ / Debian 12+, amd64 + arm64). This project - **claude-desktop-extra** - takes that official build, repackages it for **Arch, Fedora/RHEL, NixOS, and AppImage** (and offers its own Debian/Ubuntu `.deb`), and layers on Linux-only value-adds the official build lacks:

- [**Computer Use**](#computer-use) - desktop automation (screenshot, click, type, scroll, teach mode).
- [**Custom Themes**](#custom-themes) - 97 bundled dual light/dark palettes (7 built-in, 6 gaming, 84 community), each with its own loading spinner, switchable live from a Ctrl+Shift+T picker, or roll your own.
- [**Multiple Profiles**](#multiple-profiles) - run several instances side by side, each logged in to a different account with fully isolated state.
- [**Quick Entry**](#quick-entry) - global hotkey popup (Ctrl+Alt+Space), multi-monitor and Wayland-aware.
- [**Hardware Buddy**](docs/feature-flags.md) - enables the Nibblet BLE pet device on Linux: forces the feature flag so the BLE transport arms, and turns on Chromium Web Bluetooth (via BlueZ) so the in-app scan can find the device - both are off by default upstream on Linux.
- [**[...]**](PATCHES.md#community-features) - and more: panel tabs, diff view modes, a calmer Cowork glow, upstream feature-flag switches - each with its own toggle under Settings → **Extra**, and the list keeps growing ([add your own](PATCHES.md#adding-your-own-feature)).

Everything else - Chat, Cowork, Claude Code, Browser Tools, 3P/enterprise inference - is the **official upstream build**, preserved through the repackage. Where its shared cross-platform bundle still gates a feature to macOS/Windows or misbehaves on a Linux desktop, we ship a **Linux fix** (see [PATCHES.md](PATCHES.md) - each entry states exactly why it exists).

> **If you run Ubuntu 22.04+ / Debian 12+,** Anthropic's [official `.deb`](https://code.claude.com/docs/en/desktop-linux) installs the base app directly. Use this project if you're on Arch/Fedora/RHEL/Nix/AppImage, or if you want the value-adds and Linux fixes above.

## Installation

Pick your distro below. [Computer Use](#computer-use) works out of the box everywhere - all backends are bundled, nothing to install. The only optional dependency to care about is **Cowork** (agent workspace VM), listed per distro - it needs QEMU/KVM on the host, see [Cowork setup](docs/cowork.md).

<a name="arch-linux--manjaro-pacman-repository"></a>
<details>
<summary><b>Arch Linux / Manjaro (Pacman Repository)</b></summary>

```bash
# Add repository + import signing key (one-time setup)
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install-pacman.sh | sudo bash

# Install (also brings the system up to date, as Arch requires)
sudo pacman -Syu claude-desktop-extra
```

Updates arrive via `sudo pacman -Syu` (AUR helpers wrap pacman, so `yay -Syu` picks them up too). Packages and the repository database are GPG-signed with the same key as our APT and RPM repos.

**Alternative: AUR.** The same PKGBUILD is published as [`claude-desktop-extra`](https://aur.archlinux.org/packages/claude-desktop-extra), updated by CI on every release. It builds from the checksummed release tarball; the pacman repo above ships the same content pre-built and is the recommended path.

```bash
yay -S claude-desktop-extra
```

**Optional deps.** **Cowork** (agent workspace VM) is **not auto-installed** (pacman skips `optdepends`) - install QEMU/KVM once, see [Cowork setup](docs/cowork.md). Also optional: `nodejs` (system MCP servers), `sqlite` (project detection), `claude-code`.

<details>
<summary>Advanced: manual <code>pacman.conf</code> setup (without the install script)</summary>

The install script only automates these steps. Append to `/etc/pacman.conf` (on aarch64 the section name is `[claude-desktop-extra-aarch64]`; the `Server` line and the package name stay the same):

```ini
[claude-desktop-extra]
SigLevel = Required DatabaseRequired
Server = https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download
```

Then import the signing key, **verify its fingerprint**, and locally sign it:

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/gpg-key.asc -o /tmp/claude-desktop-extra.asc
gpg --show-keys --with-fingerprint /tmp/claude-desktop-extra.asc
# Must print: 825A 7D15 D78B ABE4 5646  D5DF 3824 09F5 9790 8867 - stop here if it does not.

sudo pacman-key --init            # no-op on a normal Arch install; needed on fresh keyrings, containers and chroots
sudo pacman-key --add /tmp/claude-desktop-extra.asc
sudo pacman-key --lsign-key 825A7D15D78BABE45646D5DF382409F597908867
sudo pacman -Syu claude-desktop-extra
```

The fingerprint check is what makes this trustworthy (see [Verifying the repository signing key](#verifying-the-repository-signing-key)). Both key steps are required: under `SigLevel = Required` pacman rejects the repo until the key carries your local signature, and `--lsign-key` fails with a cryptic "There is no secret key available to sign with" if the keyring was never initialised, hence the `--init`.

</details>

<details>
<summary>Build from source with <code>makepkg</code> (no third-party repository)</summary>

The `PKGBUILD` is generated and CI-tested on every release, and published as a release asset alongside `.SRCINFO` and `claude-desktop-extra.install`:

```bash
mkdir claude-desktop-extra && cd claude-desktop-extra
base=https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download
curl -fsSL -O "$base/PKGBUILD" -O "$base/claude-desktop-extra.install"
makepkg -si
```

</details>

</details>

<a name="debian--ubuntu-apt-repository"></a>
<details>
<summary><b>Debian / Ubuntu (APT Repository)</b></summary>

> **Requires Ubuntu 22.04+ / Debian 12+** (glibc 2.34 or newer). Debian 11 (bullseye) is no longer supported.

```bash
# Add repository (one-time setup)
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install.sh | sudo bash

# Install
sudo apt install claude-desktop-extra
```
Updates are automatic via `sudo apt update && sudo apt upgrade`.

**Optional deps.** **Cowork** (agent workspace VM) packages are auto-installed by `apt` (`Recommends`, mirroring Anthropic's official `.deb`); only the one-time `kvm` group step remains - see [Cowork setup](docs/cowork.md).

<details>
<summary>Manual .deb install (without APT repo)</summary>

```bash
wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/claude-desktop-extra_1.46388.2-2_amd64.deb
sudo dpkg -i claude-desktop-extra_*_amd64.deb
```

</details>

</details>

<a name="fedora--rhel-dnf-repository"></a>
<details>
<summary><b>Fedora / RHEL (DNF Repository)</b></summary>

```bash
# Add repository (one-time setup)
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install-rpm.sh | sudo bash

# Install
sudo dnf install claude-desktop-extra
```
Updates are automatic via `sudo dnf upgrade`.

**Optional deps.** **Cowork** (agent workspace VM) packages are auto-installed by `dnf` (weak deps); only the one-time `kvm` group step remains - see [Cowork setup](docs/cowork.md).

<details>
<summary>Manual .rpm install (without DNF repo)</summary>

```bash
wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/claude-desktop-extra-1.46388.2-2.x86_64.rpm
sudo dnf install ./claude-desktop-extra-*.x86_64.rpm
```

</details>

</details>

<a name="nixos--nix"></a>
<details>
<summary><b>NixOS / Nix</b></summary>

```bash
# Try without installing
nix run github:patrickjaja/claude-desktop-extra

# Or add to flake.nix
nix profile install github:patrickjaja/claude-desktop-extra
```

<details>
<summary>NixOS flake configuration</summary>

```nix
{
  inputs.claude-desktop.url = "github:patrickjaja/claude-desktop-extra";

  # In your system config:
  environment.systemPackages = [
    inputs.claude-desktop.packages.x86_64-linux.default
  ];
}
```

</details>

> **Note:** Update by running `nix flake update` to pull the latest version. `nix run` always fetches the latest.

> **Optional deps on Nix: wired automatically.** The flake pulls the Cowork tools (`qemu`, `virtiofsd`, OVMF firmware) from nixpkgs and bakes them into the app's closure - nothing to install. Use `.override { … }` to swap or drop a tool (e.g. `qemu = null;` shrinks the closure if you don't need Cowork). Two host-level steps remain, in NixOS form:
>
> ```nix
> users.users.<you>.extraGroups = [ "kvm" ];  # Cowork: /dev/kvm access (once, needs re-login)
> services.gnome.gnome-keyring.enable = true; # keeps sign-in across restarts (GNOME enables this itself)
> ```
>
> **NixOS Computer Use caveat:** the static bridges (X11 / XWayland / Sway / Hyprland / Niri) run as-is; the glibc-dynamic GNOME/KDE bridges do not - see [Computer Use dependencies](docs/computer-use-dependencies.md#nixos) for the `.override` workaround. If your flake pins a release older than v1.18286.0, virtiofsd and OVMF need manual exposure - see the notes in [`packaging/nix/package.nix`](packaging/nix/package.nix).

</details>

<a name="appimage-any-distro"></a>
<details>
<summary><b>AppImage (Any Distro)</b></summary>

Works on standard and **immutable/atomic distros** - Bazzite, Fedora Silverblue/Kinoite, SteamOS, Universal Blue, NixOS (without the Nix package), and any other glibc-based Linux.

The `claude://` protocol handler (needed for OAuth sign-in) is **automatically registered** on first launch. If you move or rename the AppImage, the registration updates on the next launch.

```bash
# Download from GitHub Releases
wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/Claude_Desktop-1.46388.2-x86_64.AppImage
chmod +x Claude_Desktop-*-x86_64.AppImage
./Claude_Desktop-*-x86_64.AppImage
```

> **Update:** AppImage supports delta updates via [appimagetool](https://github.com/AppImageCommunity/AppImageUpdate) - only changed blocks are downloaded (`appimageupdatetool Claude_Desktop-*.AppImage`, or `--appimage-update` from within). Compatible with [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) and [Gear Lever](https://github.com/mijorus/gearlever). Use `--integrate` / `--unintegrate` / `--diagnose` to manage the protocol handler.
>
> **Optional deps.** For **Cowork** (VM), install QEMU + UEFI firmware + virtiofsd from your host's repos - per-distro commands in [Cowork setup](docs/cowork.md).

</details>

<a name="from-source"></a>
<details>
<summary><b>From Source</b></summary>

```bash
git clone https://github.com/patrickjaja/claude-desktop-extra.git
cd claude-desktop-extra
./scripts/build-local.sh --install
```

> **Note:** Source builds do not receive automatic updates. Pull and rebuild to update.
>
> **Optional deps.** A source build installs the native package for your distro, so the optional deps match that distro's section above; Cowork commands are in [Cowork setup](docs/cowork.md) (on Arch install them by hand - pacman doesn't pull `optdepends`).

</details>

<a name="arm64--aarch64-raspberry-pi-5-nvidia-dgx-spark-jetson-etc"></a>
<details>
<summary><b>ARM64 / aarch64 (Raspberry Pi 5, NVIDIA DGX Spark, Jetson, etc.)</b></summary>

ARM64 `.deb`, `.rpm`, AppImage, and Nix packages are available for **Raspberry Pi 5**, **NVIDIA DGX Spark** (Ubuntu 24.04 arm64), and **Jetson** (JetPack/Ubuntu 22.04 arm64). The APT and DNF repos serve both x86_64 and arm64 - your package manager picks the correct architecture automatically. Install exactly as above.

</details>

<a name="migrating-from-claude-desktop-bin"></a>
<details>
<summary><b>Migrating from claude-desktop-bin</b></summary>

The project was renamed from `claude-desktop-bin` to `claude-desktop-extra`, and the switch is automatic: the package replaces itself on your next regular upgrade (apt, dnf, and pacman all handle it), and your themes / flag overrides (`claude-desktop-bin.jsonc`) are migrated on first launch.

One exception: an existing `[claude-desktop-bin]` section in `/etc/pacman.conf` points at a temporary transition mirror - replace it with the `[claude-desktop-extra]` stanza from the [Arch section above](#arch-linux--manjaro-pacman-repository) (same `SigLevel`, same signing key; aarch64: `[claude-desktop-extra-aarch64]`).

</details>

<a name="cowork-setup-needs-devkvm"></a>
<details>
<summary><b>Cowork setup (needs /dev/kvm)</b> - optional, applies to every install path</summary>

Cowork (and Dispatch) run on the **official native Cowork VM backend** bundled inside the package - the same one Anthropic ships in the official Linux build. Sessions run in a lightweight VM with `$HOME` shared in, so the host needs **QEMU + UEFI firmware + virtiofsd** and access to **`/dev/kvm`**.

The `.deb` and `.rpm` packages pull those in automatically and the Nix flake bakes them into the closure; on **Arch**, **AppImage** and source builds you install them from your distro's repos. Either way, join the `kvm` group once (`sudo usermod -aG kvm "$USER"`, then log out and back in).

Per-distro install commands, the troubleshooting table for every popup Cowork can show, and what `claude-desktop --diagnose` reports: **[docs/cowork.md](docs/cowork.md)**. For what Cowork itself is and how to use it, see Anthropic's [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork).

</details>

<a name="verifying-the-repository-signing-key"></a>
<details>
<summary><b>Verifying the repository signing key</b> (applies to the APT, DNF and pacman repos)</summary>

The APT, DNF and pacman repositories are GPG-signed with the same key. The install scripts import it from GitHub Pages over HTTPS. To verify the key out-of-band, compare its fingerprint against the value published here (this README lives in the git repo, a separate channel from the Pages-hosted key):

```
Key:         Claude Desktop Linux (claude-desktop-bin repo signing key) <patrickjajaa@gmail.com>
Type:        RSA 4096
Fingerprint: 825A 7D15 D78B ABE4 5646  D5DF 3824 09F5 9790 8867
```

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/gpg-key.asc | gpg --show-keys --with-fingerprint
# The printed fingerprint must match the value above.
```

</details>

## The "Extra" Settings

This package adds its own section to Claude's Settings dialog: **Extra** - the home of everything this project layers on top of the official build, and where new features land first.

![The Extra section in Claude's Settings: Themes with the Gaming palettes, next to Features](docs/global/2026-07-29_20-21-extra.png)

Four panels today:

- **Extra → Themes** - all **97 bundled palettes** with live color dots; one click applies instantly in every open window. Make Claude Desktop blend into your Linux desktop: palettes matching stock DE looks (ADW/Adwaita, Breeze) sit next to the classics (Catppuccin, Nord, Gruvbox, Rose Pine, Everforest) and a [Gaming collection](docs/themes.md).
- **Extra → Community Features** - the **5 optional features** this project currently adds, each as a switch ([9 patches](PATCHES.md#community-features): Files quick open, panel tabs, diff view modes, the theme-picker hotkey, a calmer Cowork glow), with a filter box over them.
  - **Files quick open** - <kbd>Ctrl</kbd>+<kbd>P</kbd> on the Code tab opens a VS Code-style quick-open box over the Files panel. Type part of a name - spaces split the query into pieces that must all match, in any order, so `user service` finds `user-service.spec.ts` - pick with the arrow keys or the mouse, and <kbd>Enter</kbd> opens it as a file tab in the panel; `:42` jumps to a line, an empty query lists what you opened recently. The same fix reaches the Files panel's own filter and the composer's `@` file picker. Opt-in: Settings → Extra → Community Features - the hotkey applies live, the spaces fix reaches the file index on its next start (after a restart).
- **Extra → Anthropic Features** - all **134 upstream [feature flags](#feature-flag-overrides-advanced)** this build reads, each as a switch - no config-file editing needed.
- **Extra → Deployment** - a **1P / 3P switch** plus the whole [third-party inference](#third-party--enterprise-inference) configuration as toggles and fields. Turning 3P on used to be a one-way door without a root shell; here it is a button, and every value is written to your own profile directory.

Every panel ends in the config file behind it, as a link: click the path to open the file, or the **folder** button to show it in your file manager.

Expect this section to grow - Extra is where the project is heading.

## Computer Use

**Our exclusive feature - not part of the official Linux build.** Claude Desktop's built-in Computer Use MCP server exposes 27 tools for desktop automation (screenshot, click, type, scroll, drag, clipboard, and more), plus **learn tools** that generate interactive overlay tutorials for any app. Upstream gates it to macOS/Windows and ships no Linux backend; the patch ([`fix_computer_use_linux.nim`](patches/linux/fix_computer_use_linux.nim)) removes the platform gates and injects a Linux executor that auto-detects your session and routes to a bundled first-party bridge: [`x11-bridge`](https://github.com/patrickjaja/x11-bridge) on X11 / XWayland, [`wlroots-bridge`](https://github.com/patrickjaja/wlroots-bridge) on Sway / Hyprland / Niri (native virtual-pointer/keyboard + screencopy + foreign-toplevel protocols), [`gnome-portal-bridge`](https://github.com/patrickjaja/gnome-bridge) on GNOME Wayland (XDG RemoteDesktop + ScreenCast portal, one consent dialog per session, persisted on GNOME 46+; needs PipeWire >= 1.0.5, i.e. Ubuntu 24.04+ / Fedora 40+ / Debian 13+), and [`kwin-portal-bridge`](https://github.com/patrickjaja/kwin-portal-bridge) on KDE Plasma 6.6+. No third-party input/screenshot tools needed; only exotic Wayland compositors fall back to `ydotool`.

**Nothing to install** - the bridges ship inside the package. See **[docs/computer-use.md](docs/computer-use.md)** for how it works, the notes (primary-monitor, app discovery, teach overlay), and links to the [tool reference](baseline/CLAUDE_BUILT_IN_MCP.md#17-computer-use); [Computer Use dependencies](docs/computer-use-dependencies.md) has the per-session matrix and the exotic-compositor `ydotool` fallback.

**KDE Plasma needs 6.6+** for the native KWin route (earlier Plasma lacks the KWin capture-hiding API) - below that, Computer Use falls back to `ydotool`/`spectacle`; updating Plasma restores the full experience. `claude-desktop --diagnose` prints your KWin version and which route is active.

## Custom Themes

Recolor the whole app - chat, sidebar, Code/Cowork, dialogs, Quick Entry - with **97 bundled dual light/dark palettes**: 7 curated built-ins, 6 gaming palettes, and 84 community ports (Catppuccin, Nord, Gruvbox, Rose Pine, Everforest, Tokyo Night and more). Each ships a `light` and a `dark` variant, so the app's own Appearance toggle picks the matching one live, and each carries its own loading spinner.

**Quick start** - press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> anywhere in the app, pick a theme from the searchable gallery, and it applies immediately in every open window. No restart, no config file. The same list sits in Settings → **Extra** → **Themes**.

| Light (overworld) | Dark (underground) |
|-------------------|--------------------|
| ![Mario theme - light](themes/mario/2026-06-26_14-46-chat-light.png) | ![Mario theme - dark](themes/mario/2026-06-26_14-46-chat-dark.png) |

Browse all 97 with their swatches in **[themes/PALETTES.md](themes/PALETTES.md)**. The palette tables, the config file, custom CSS and spinners, and how to author your own: **[docs/themes.md](docs/themes.md)**.

## Multiple Profiles

Run several Claude Desktop instances side by side, each logged in to a different account, with fully isolated state for both Desktop and the Claude Code CLI it spawns. Useful for separating work from personal accounts, juggling SSO tenants, or testing config without touching your main install.

```bash
claude-desktop --create-profile=work    # then launch it with claude-desktop-work
```

The default profile stays byte-identical to a single-instance install, and you can run it alongside any number of named ones. What exactly is isolated, how SSO callbacks find their way back, removing a profile, and the disk-cost note: **[docs/profiles.md](docs/profiles.md)**.

## Quick Entry

A global-hotkey popup (default <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd>) that opens a compact Claude prompt on the monitor where your cursor is. It works out of the box on **KDE Plasma**, **Hyprland** and **Sway** via `xdg-desktop-portal` GlobalShortcuts; on **GNOME** the portal silently fails to register, so run `claude-desktop --install-gnome-hotkey` once after install.

Bind it to any key yourself with `claude-desktop --toggle`, which opens the popup in milliseconds and starts the app if it isn't running. Per-desktop setup and hotkey troubleshooting: **[docs/quick-entry.md](docs/quick-entry.md)**.

## Third-Party / Enterprise Inference

**Run Claude Desktop entirely on your own inference backend - no personal claude.ai login required.** Point it at **Bedrock** (AWS), **Vertex AI** (Google Cloud), **Azure AI Foundry** (Microsoft), or any **Anthropic-compatible gateway** (LiteLLM, Portkey, in-house proxies). Chat, Code, and Cowork all work in 3P mode on Linux.

**Our exclusive addition: Settings → Extra → [Deployment](#the-extra-settings).** A **1P / 3P switch** and the full configuration as toggles and fields - provider and credentials, which tabs exist, the workspace and egress allowlists, telemetry, update policy, usage limits. It writes the same schema the enterprise policy file uses, into **your own profile directory** (`~/.config/Claude-3p/configLibrary/`, the store upstream's own 3P Setup uses), so nothing here needs `sudo`, and each [profile](#multiple-profiles) has its own. Two things it deliberately refuses to write: `disableDeploymentModeChooser`, the key that locks a machine into 3P, and `managedMcpServers`, whose entries can start a process - both stay read-only, and remain yours to deploy through the policy file. Stored credentials are write-only: the panel can replace one but never shows it.

Fleet rollouts still take the policy route: `/etc/claude-desktop/managed-settings.json` is read natively by the official build, needs root, and wins over everything local while it is in place (the panel says so, and turns read-only).

The official 3P docs cover only macOS and Windows. **[docs/third-party-inference.md](docs/third-party-inference.md)** is the Linux guide: the [in-app panel](docs/third-party-inference.md#route-a-the-in-app-deployment-panel), a [5-minute LiteLLM quickstart](docs/third-party-inference.md#5-minute-local-quickstart-litellm-container), worked Vertex AI / gateway / Bedrock examples, the [maximum `managed-settings.json`](docs/third-party-inference.md#maximum-managed-settingsjson-every-key), the [`enterprise.json` → `managed-settings.json` migration](docs/third-party-inference.md), and [switching back to personal (1P)](docs/third-party-inference.md#common-gotchas).

## Patches

The official Linux build ships one cross-platform JS bundle that gates plenty of features to macOS and Windows, and some of its behavior misfires on a Linux desktop. We apply a set of surgical JS patches to the `app.asar` at repackage time - one directory per purpose:

- **[`patches/community/`](PATCHES.md#community-features)** (9 patches) - optional features you switch on yourself in Settings → **Extra** → **Community Features**. Off unless you ask for them (the theme picker is the exception, on by default).
- **[`patches/core/`](PATCHES.md#core-infrastructure)** (7 patches) - always-on infrastructure the rest builds on: the Extra settings pages themselves, the theme engine, the flag-override mechanism, and the multi-profile plumbing.
- **[`patches/linux/`](PATCHES.md#linux-compatibility)** (31 patches) - upstream features still gated to macOS/Windows in the shared bundle, or that break in a Linux environment. Always on, nothing to configure.

We keep the set as small as possible: every patch is re-audited against a fresh bundle on each upstream release, a pattern that no longer matches fails the build rather than silently doing nothing, and a patch is removed outright once Anthropic ships that behavior natively.

**Full catalog and per-patch descriptions: [PATCHES.md](PATCHES.md).**

### Adding your own feature

Every feature on this page started as one `.nim` file, and adding another is a small, well-marked job. A community patch gets a switch in the app's own Settings dialog for the cost of one spec, and its setting is persisted per profile in your config, so users keep control without rebuilding anything. If Claude Desktop doesn't behave the way you need it to on your desktop, **spin up your favorite coding agent in a clone of this repo** - [AGENTS.md](AGENTS.md) plus the recipe below is enough context to add a patch end to end, and the bundled [skills](.claude/skills/) keep it on this project's rails (Claude Code picks them up automatically, e.g. `/linux` for the compatibility rules).

**The full recipe: [Adding your own feature](PATCHES.md#adding-your-own-feature).**

## Command-line flags

Flags this project adds on top of the official build (run `claude-desktop --help` for the full list). All are optional; without any, `claude-desktop` just launches the default profile.

| Flag | Description |
|------|-------------|
| `--profile=NAME` | Launch (or target a subcommand at) a named [profile](#multiple-profiles). Also selectable via a `claude-desktop-NAME` shortcut or `CLAUDE_PROFILE=NAME` |
| `--create-profile=NAME` | Create a [profile](#multiple-profiles) (user-local binary, launcher, and menu entry; own login/logs/config) |
| `--delete-profile=NAME` | Remove a profile's entry points (user data preserved) |
| `--list-profiles` | List installed profiles |
| `--toggle` | Toggle the [Quick Entry](#quick-entry) overlay (bind to a global shortcut) |
| `--install-gnome-hotkey [ACCEL]` | Bind the Quick Entry hotkey on GNOME, where the portal doesn't (default `Ctrl+Alt+Space`); `--uninstall-gnome-hotkey` removes it |
| `--1p` / `--3p` | Select personal claude.ai (1P) vs [third-party inference](docs/third-party-inference.md) (3P) mode by persisting the upstream `deploymentMode` key; replaces the removed upstream `--boot-1p-once` flag. The same switch is in the app under Settings → **Extra** → **Deployment**. See [switching back to 1P](docs/third-party-inference.md#common-gotchas) |
| `--native-titlebar` | Use the native window frame instead of the integrated titlebar (same as `CLAUDE_NATIVE_TITLEBAR=1`) |
| `--no-systemd-scope` | Skip the `systemd --user --scope` wrapper for this launch (same as `CLAUDE_DISABLE_SYSTEMD_SCOPE=1`) |
| `--diagnose` | Print session type, portal status, and hotkey state for issue reports |
| `--integrate` / `--unintegrate` | Register / remove the `claude://` handler and menu entry (AppImage only; happens automatically on launch) |

## Environment Variables

`claude-desktop` reads a handful of env vars at launch (all optional). The ones people reach for most:

| Variable | Values | Description |
|----------|--------|-------------|
| `CLAUDE_DISABLE_GPU` | `1`, `full` | Fix white screen on some GPU/driver combos ([#13](https://github.com/patrickjaja/claude-desktop-extra/issues/13)). `1` disables compositing only, `full` disables GPU entirely |
| `CLAUDE_PROFILE` | name | Select a [profile](#multiple-profiles) by name (also `claude-desktop-NAME` / `--profile=NAME`) |
| `CLAUDE_NATIVE_TITLEBAR` | `1` | Restore the native window frame instead of the integrated titlebar (same as `--native-titlebar`) |
| `CLAUDE_USE_XWAYLAND` | `1` | Force XWayland instead of native Wayland. Also fixes "app exits after seconds" GPU crashes ([#180](https://github.com/patrickjaja/claude-desktop-extra/issues/180), see [wayland.md](wayland.md)) |
| `CLAUDE_PASSWORD_STORE` | backend, `auto` | Force the Chromium keyring backend (`gnome-libsecret`, `kwallet6`, `basic`, ...). Default: on desktops Chromium gives no keyring backend (Hyprland, sway, XFCE, ...), a running Secret Service is used automatically so sign-in persists ([#191](https://github.com/patrickjaja/claude-desktop-extra/issues/191)). `auto` disables that detection |
| `CLAUDE_KEEP_TTY` | `1` | Keep the controlling terminal instead of calling `setsid` when launched as a background job on one. Only affects `startx`/`xinit` sessions, where a panel or menu launch would otherwise let the app's `bash -l -i -c` environment probe `SIGTTIN` the whole desktop process group ([#213](https://github.com/patrickjaja/claude-desktop-extra/pull/213)) |

Set permanently in `~/.bashrc` / `~/.zshrc`, or pass per-launch: `CLAUDE_DISABLE_GPU=1 claude-desktop`

**Full list** (profile/config dirs, Vulkan, menu bar, DevTools, systemd-scope, Electron overrides, …) → **[docs/environment-variables.md](docs/environment-variables.md)**.

## Feature Flag Overrides (advanced)

Claude Desktop gates many features behind server-side GrowthBook flags with no built-in local override. This package adds one: a `growthbookOverrides` block in **`~/.config/Claude/claude-desktop-extra.jsonc`** (per-profile, auto-created on first launch with a commented template listing every flag the app reads).

**Or flip them in the app:** Settings → **Extra** → **Anthropic Features** renders the same catalog - all 134 flags - as switches, pre-set to what your account actually gets.

The file format, how overrides win over the server rollout, the full flag catalog, and the caveats: **[docs/feature-flags.md](docs/feature-flags.md)**.

## Debugging

Runtime logs are in `~/.config/Claude/logs/` (`main.log`, `claude.ai-web.log`, `mcp.log`). With a 3P `managed-settings.json` present, logs are under `~/.config/Claude-3p/`; named profiles use `~/.config/Claude-<profile>/`.

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

Computer Use patches emit `[claude-cu] diagnostics:` lines showing the detected session, available/missing tools, and screenshot cascade. They land in `~/.config/Claude/logs/claude-patches.log` (and on stderr when launched from a terminal) - share that log file when reporting Computer Use issues. The official build discards plain `console.log` output, so the old "run from a terminal and copy the output" advice only shows Chromium noise.

`claude-desktop --diagnose` additionally prints a **Computer Use** section: the installed package version, bundled-bridge presence, and on KDE Wayland the KWin 6.6-gate verdict plus a portal-free `windows` self-test through the kwin-portal-bridge (no consent dialog; window titles are never printed). Attach that output together with `claude-patches.log` - the pair makes most Computer Use reports diagnosable without follow-up questions.

## Known Limitations

- **App identity on Wayland.** `xdg-desktop-portal` resolves unsandboxed apps via the systemd user scope. We launch under `app-com.anthropic.Claude-*.scope` and install the `.desktop` as `com.anthropic.Claude.desktop` - the same reverse-DNS identity the official build uses, and the value Chromium derives the window `app_id` / `WM_CLASS` from - so scope, `app_id`, `StartupWMClass`, and `.desktop` basename all agree. KDE global shortcuts and persistent portal authorizations (screen share / Computer Use consent) attach to that id and survive across sessions.
  - Pinned taskbar/dock shortcuts from an earlier release (`claude-desktop.desktop` or older names) orphan on upgrade - **re-pin once**.
  - Custom X11/Wayland WM rules matching `claude-desktop` (or older `claude` / `com.anthropic.claude-desktop`) need updating to `com.anthropic.Claude`. The window `app_id` is shared across named profiles.
  - KDE screen-share / Computer Use consent granted before the rename is keyed to the old id - re-grant once; it persists from then on.
  - GNOME shell-extension blacklists (Rounded Window Corners, Unite, Blur My Shell) referencing `com.anthropic.claude-quick-entry` should become `claude-quick-entry`.
  - **NixOS** doesn't use `systemd-run --scope`; portal identity may not resolve on GNOME Wayland - use `--install-gnome-hotkey`.
  - **Sandboxes/containers** without a reachable user-systemd (bwrap, distrobox, restricted Flatpaks) auto-skip the scope wrap; force it with `--no-systemd-scope` / `CLAUDE_DISABLE_SYSTEMD_SCOPE=1` if the socket exists but is unreachable ([#89](https://github.com/patrickjaja/claude-desktop-extra/issues/89)).
- **Computer Use targets the primary monitor** - screenshots/clicks can be retargeted with `switch_display`; the teach overlay stays on the primary display. See [Computer Use](#computer-use).
- **CoworkSpaces are local-only** on every platform (no account-sync) - a set created on macOS/Windows won't transfer to Linux. Upstream behavior.

## Automation

CI polls the official apt Packages index every 2 hours, downloads the latest official `.deb` (verifying GPG + SHA256), extracts and patches its `app.asar`, and **validates every patch in Docker** (`makepkg` in `archlinux:base-devel`) before publishing. Each patch exits 1 if its pattern doesn't match, so a broken package never reaches users - the pipeline stops with a clear `[FAIL]` and the published repositories stay on the last-good version until patches are updated.

## Repository Structure

- `.github/workflows/` - GitHub Actions automation (ingest, patch, validate, publish)
- `scripts/` - build, validation, and launcher scripts
- `patches/` - Nim patch sources + Makefile (compiled to native binaries), grouped into `linux/` (Linux compatibility), `community/` (opt-in features) and `core/` (always-on infrastructure)
- `js/` - shared JS snippets embedded by the patches
- `PATCHES.md` - the patch catalog: what every patch does and why it exists
- `docs/` - per-feature deep-dives (themes, profiles, Quick Entry, Cowork, feature flags, Computer Use, third-party inference) and screenshots
- `packaging/` - Debian, RPM, AppImage, and Nix build scripts
- `baseline/` - version-sensitive reference docs re-validated each release
- `PKGBUILD.template` - pacman package template

## See Also

- [tweakcc](https://github.com/Piebald-AI/tweakcc) - a CLI tool for customizing Claude Code (system prompts, themes, UI). Same patching-JS-to-make-it-yours energy. Thanks to the Piebald team.

## Legal Notice

> This is an **unofficial community project** for educational and research purposes.
> Claude Desktop is proprietary software owned by **Anthropic PBC**.
>
> This repository contains only build scripts and patches - not the Claude Desktop
> application itself. The upstream binary is downloaded directly from Anthropic
> during the build process.
>
> This project is not affiliated with, endorsed by, or sponsored by Anthropic.
> "Claude" is a trademark of Anthropic PBC.

---

<p align="center"><sub>Built with ❤️ for the Linux community</sub></p>
