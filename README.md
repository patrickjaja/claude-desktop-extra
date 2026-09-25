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

**Anthropic's official Claude Desktop Linux build, repackaged for Arch, Fedora/RHEL, NixOS and AppImage (plus our own `.deb`), with Linux-only extras on top:** [Computer Use](#computer-use), [custom themes](#custom-themes), [multiple profiles](#multiple-profiles), [Quick Entry](#quick-entry), and more under [Settings → Extra](#the-extra-settings).

Everything else - Chat, Cowork, Claude Code, Browser Tools, 3P inference - is the official upstream build. On Ubuntu 22.04+ / Debian 12+ you can also install [Anthropic's official `.deb`](https://code.claude.com/docs/en/desktop-linux) directly; use this project for the other distros or for the extras.

## Quick install

| Distro | Command |
|--------|---------|
| Arch / Manjaro | `yay -S claude-desktop-extra` ([AUR](https://aur.archlinux.org/packages/claude-desktop-extra); no AUR helper: [signed pacman repo](#arch-linux--manjaro-pacman-repository)) |
| Debian / Ubuntu | `curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install.sh \| sudo bash && sudo apt install claude-desktop-extra` |
| Fedora / RHEL | `curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install-rpm.sh \| sudo bash && sudo dnf install claude-desktop-extra` |
| NixOS / Nix | `nix run github:patrickjaja/claude-desktop-extra` |
| Any distro | [AppImage from the latest release](https://github.com/patrickjaja/claude-desktop-extra/releases/latest) |

Updates arrive through your package manager. x86_64 and aarch64 are supported everywhere except Nix (x86_64 only). **Cowork** (the agent VM) is optional and needs QEMU/KVM, see [Cowork setup](#cowork-setup-needs-devkvm). Details per distro:

<a name="arch-linux--manjaro-pacman-repository"></a>
<details>
<summary><b>Arch Linux / Manjaro (AUR or pacman repository)</b></summary>

```bash
yay -S claude-desktop-extra              # or: paru -S claude-desktop-extra / Manjaro: pamac build claude-desktop-extra
```

Updates arrive with `yay -Syu`. The [PKGBUILD](https://aur.archlinux.org/packages/claude-desktop-extra) is readable on the AUR before you build: it downloads the prebuilt, SHA256-pinned release tarball and repackages it (no compiling). CI updates it on every release; x86_64 and aarch64.

**Without an AUR helper: signed pacman repository.** The same package, prebuilt and GPG-signed, updated by `sudo pacman -Syu`:

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install-pacman.sh | sudo bash   # repo + signing key, once
sudo pacman -Syu claude-desktop-extra
```

**Optional deps** (not installed automatically): QEMU/KVM for Cowork ([setup](docs/cowork.md)), `nodejs` (system MCP servers), `sqlite` (project detection), `gjs` (GNOME search provider), `claude-code`.

<details>
<summary>Manual <code>pacman.conf</code> setup (without the install script)</summary>

Append to `/etc/pacman.conf` (aarch64: section `[claude-desktop-extra-aarch64]`, same `Server`):

```ini
[claude-desktop-extra]
SigLevel = Required DatabaseRequired
Server = https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download
```

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/gpg-key.asc -o /tmp/claude-desktop-extra.asc
gpg --show-keys --with-fingerprint /tmp/claude-desktop-extra.asc
# Must print: 825A 7D15 D78B ABE4 5646  D5DF 3824 09F5 9790 8867 - stop here if it does not.
sudo pacman-key --init            # needed on fresh keyrings, containers and chroots
sudo pacman-key --add /tmp/claude-desktop-extra.asc
sudo pacman-key --lsign-key 825A7D15D78BABE45646D5DF382409F597908867
sudo pacman -Syu claude-desktop-extra
```

</details>

<details>
<summary>Build with <code>makepkg</code> (no third-party repository)</summary>

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

Requires Ubuntu 22.04+ / Debian 12+ (glibc 2.34+).

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install.sh | sudo bash   # repo, once
sudo apt install claude-desktop-extra
```

It replaces Anthropic's own `claude-desktop` package if installed (same files). Cowork packages come in as `Recommends`; only the `kvm` group step remains ([Cowork setup](docs/cowork.md)).

Without the repo: `wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/claude-desktop-extra_2.7032.0-2_amd64.deb && sudo dpkg -i claude-desktop-extra_*_amd64.deb`
</details>

<a name="fedora--rhel-dnf-repository"></a>
<details>
<summary><b>Fedora / RHEL (DNF Repository)</b></summary>

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/install-rpm.sh | sudo bash   # repo, once
sudo dnf install claude-desktop-extra
```

Cowork packages come in as weak deps; only the `kvm` group step remains ([Cowork setup](docs/cowork.md)).

Without the repo: `wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/claude-desktop-extra-2.7032.0-2.x86_64.rpm && sudo dnf install ./claude-desktop-extra-*.x86_64.rpm`
</details>

<a name="nixos--nix"></a>
<details>
<summary><b>NixOS / Nix</b></summary>

Try it with `nix run github:patrickjaja/claude-desktop-extra`, install with `nix profile install github:patrickjaja/claude-desktop-extra`. Flake: add `inputs.claude-desktop.url = "github:patrickjaja/claude-desktop-extra";` and put `inputs.claude-desktop.packages.x86_64-linux.default` in `environment.systemPackages`. Update with `nix flake update`. "Start at login" and profile shortcuts run through the package wrapper, so they survive a garbage collection.

Cowork tools (`qemu`, `virtiofsd`, OVMF) are baked into the closure (`.override { qemu = null; }` drops them). Host steps: `users.users.<you>.extraGroups = [ "kvm" ];` and, outside GNOME, `services.gnome.gnome-keyring.enable = true;` to keep sign-in. The GNOME/KDE Computer Use bridges need an override on NixOS, see [Computer Use dependencies](docs/computer-use-dependencies.md#nixos).
</details>

<a name="appimage-any-distro"></a>
<details>
<summary><b>AppImage (Any Distro)</b></summary>

Works on standard and immutable distros (Bazzite, Silverblue/Kinoite, SteamOS, Universal Blue). The `claude://` handler for sign-in registers itself on first launch.

```bash
wget https://github.com/patrickjaja/claude-desktop-extra/releases/latest/download/Claude_Desktop-2.7032.0-x86_64.AppImage
chmod +x Claude_Desktop-*-x86_64.AppImage && ./Claude_Desktop-*-x86_64.AppImage
```

Delta updates: `appimageupdatetool Claude_Desktop-*.AppImage`. Works with AppImageLauncher and Gear Lever. For Cowork, install QEMU + UEFI firmware + virtiofsd from your distro ([Cowork setup](docs/cowork.md)).
</details>

<a name="from-source"></a>
<details>
<summary><b>From Source</b></summary>

Clone the repo and run `./scripts/build-local.sh --install`. No automatic updates; pull and rebuild.
</details>

<a name="arm64--aarch64-raspberry-pi-5-nvidia-dgx-spark-jetson-etc"></a>
<details>
<summary><b>ARM64 / aarch64 (Raspberry Pi 5, NVIDIA DGX Spark, Jetson, etc.)</b></summary>

`.deb`, `.rpm`, pacman and AppImage packages exist for arm64; the repos pick the right architecture. Install as above. Cowork on ARM boards: [notes](docs/cowork.md#distro-and-hardware-notes).
</details>

<a name="migrating-from-claude-desktop-bin"></a>
<details>
<summary><b>Migrating from claude-desktop-bin</b></summary>

The package replaces itself on the next regular upgrade, and your config is migrated on first launch. Only an old `[claude-desktop-bin]` section in `/etc/pacman.conf` needs replacing with the [Arch stanza above](#arch-linux--manjaro-pacman-repository).
</details>

<a name="cowork-setup-needs-devkvm"></a>
<details>
<summary><b>Cowork setup (needs /dev/kvm)</b> - optional, every install path</summary>

Cowork and Dispatch run on the official native VM backend bundled in the package. The host needs QEMU + UEFI firmware + virtiofsd and access to `/dev/kvm`: join the `kvm` group once (`sudo usermod -aG kvm "$USER"`, then log out and in). Per-distro commands and troubleshooting: [docs/cowork.md](docs/cowork.md).
</details>

<a name="verifying-the-repository-signing-key"></a>
<details>
<summary><b>Verifying the repository signing key</b> (APT, DNF and pacman)</summary>

```
Key:         Claude Desktop Linux (claude-desktop-bin repo signing key) <patrickjajaa@gmail.com>
Type:        RSA 4096
Fingerprint: 825A 7D15 D78B ABE4 5646  D5DF 3824 09F5 9790 8867
```

Check it with `curl -fsSL https://patrickjaja.github.io/claude-desktop-extra/gpg-key.asc | gpg --show-keys --with-fingerprint`.
</details>

## The "Extra" Settings

Settings → **Extra** holds everything this project adds: **Themes**, **Community Features** (opt-in switches such as Files quick open, panel tabs, diff view modes), **Anthropic Features** (every upstream feature flag as a switch) and **Deployment** (1P/3P switch and the full third-party inference config, no `sudo` needed).

![The Extra section in Claude's Settings](docs/global/2026-07-29_20-21-extra.png)

## Computer Use

Desktop automation (screenshot, click, type, scroll, teach mode) - not part of the official Linux build. Bundled bridges cover X11, XWayland, Sway / Hyprland / Niri, GNOME Wayland (PipeWire >= 1.0.5) and KDE Plasma 6.6+, with nothing to install. Details: [docs/computer-use.md](docs/computer-use.md), per-session matrix: [dependencies](docs/computer-use-dependencies.md).

## Custom Themes

97 dual light/dark palettes (Catppuccin, Nord, Gruvbox, gaming themes, ...). Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> to pick one live. Theme files reload live, so [matugen](https://github.com/InioX/matugen), pywal or wallust can recolor the app from your wallpaper. Guide: [docs/themes.md](docs/themes.md), gallery: [themes/PALETTES.md](themes/PALETTES.md).

![Mario theme - dark](themes/mario/2026-06-26_14-46-chat-dark.png)

## Multiple Profiles

Run several instances side by side, each with its own account and fully isolated state: `claude-desktop --create-profile=work`, then launch `claude-desktop-work`. Details: [docs/profiles.md](docs/profiles.md).

## Quick Entry

Global hotkey popup (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd>) on the monitor under your cursor. Works as installed on KDE; on other desktops bind `claude-desktop --toggle` to a key. Per-desktop setup: [docs/quick-entry.md](docs/quick-entry.md).

## Third-Party / Enterprise Inference

Run on Bedrock, Vertex AI, Azure AI Foundry or any Anthropic-compatible gateway, without a claude.ai login. Configure it in Settings → Extra → Deployment, or fleet-wide via `/etc/claude-desktop/managed-settings.json`. Linux guide: [docs/third-party-inference.md](docs/third-party-inference.md).

## Feature Flag Overrides (advanced)

Override Anthropic's server-side feature flags in `~/.config/Claude/claude-desktop-extra.jsonc`, or flip them in Settings → Extra → Anthropic Features. Details: [docs/feature-flags.md](docs/feature-flags.md).

## Patches

We patch the official `app.asar` at repackage time: [`patches/community/`](docs/patches.md#community-features) (10 patches, opt-in features), [`patches/core/`](docs/patches.md#core-infrastructure) (7, infrastructure) and [`patches/linux/`](docs/patches.md#linux-compatibility) (33, Linux fixes). A patch that stops matching fails the build, and a patch is removed once upstream ships the behavior. Catalog: [docs/patches.md](docs/patches.md).

## Command-line flags

`claude-desktop --help` lists them (`--profile=NAME`, `--toggle`, `--diagnose`, `--1p` / `--3p`, ...). Reference: [docs/command-line.md](docs/command-line.md). Environment variables (e.g. `CLAUDE_DISABLE_GPU=1` or `CLAUDE_GPU_BACKEND=angle-gl` for a white screen or GPU crash): [docs/environment-variables.md](docs/environment-variables.md).

## Troubleshooting

<a name="debugging"></a><a name="known-limitations"></a>
Logs are in `~/.config/Claude/logs/` (3P mode: `~/.config/Claude-3p/logs/`, named profiles: `~/.config/Claude-<profile>/logs/`). Common problems and known limitations: [docs/troubleshooting.md](docs/troubleshooting.md).

**Reporting a bug:** attach the output of these two commands to your issue. Linux setups differ a lot, and this is what makes a report diagnosable:

```bash
claude-desktop --diagnose > diagnose.txt
cp ~/.config/Claude/logs/claude-patches.log .   # 3P mode: ~/.config/Claude-3p/logs/claude-patches.log
```

## Development

```bash
git clone https://github.com/patrickjaja/claude-desktop-extra.git && cd claude-desktop-extra
./scripts/build-local.sh
```

To add a feature, write one patch following [Adding your own feature](docs/patches.md#adding-your-own-feature), then open a PR. [AGENTS.md](AGENTS.md) has the project rules; the bundled [skills](.claude/skills/) are optional helpers for Claude Code.

## See Also

- [tweakcc](https://github.com/Piebald-AI/tweakcc) - a CLI tool for customizing Claude Code (system prompts, themes, UI). Same patching-JS-to-make-it-yours energy. Thanks to the Piebald team.
- [agent-skills](https://github.com/addyosmani/agent-skills) - production-grade engineering skills for AI coding agents; the maintainer uses them to spec, plan and build changes here.

## Legal Notice

> This is an **unofficial community project** for educational and research purposes. Claude Desktop is proprietary software owned by **Anthropic PBC**. This repository contains only build scripts and patches - not the Claude Desktop application itself; the upstream binary is downloaded directly from Anthropic during the build. This project is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic PBC.

---

<p align="center"><sub>Built with ❤️ for the Linux community</sub></p>
