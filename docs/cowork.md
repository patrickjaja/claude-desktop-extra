# Cowork setup (needs /dev/kvm)

What Cowork and Dispatch need from the host, per distro, and what to do when a popup says something is missing. For the short version, see [Cowork setup in the README](../README.md#cowork-setup-needs-devkvm); for what Cowork itself is and how to use it, see Anthropic's official [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork).

Cowork (and Dispatch) run on the **official native Cowork VM backend** bundled inside the package (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF) - the same backend Anthropic ships in the official Linux build. There's no separate daemon to install; sessions run in a lightweight VM with `$HOME` shared in, which requires **`/dev/kvm`** on the host.

## Setup

**1. Install QEMU + UEFI firmware + virtiofsd.** The `.deb` / `.rpm` packages pull them automatically (`Recommends` / weak deps, matching Anthropic's official `.deb`), and the Nix flake bakes them into the app's closure. On **Arch** (pacman skips `optdepends`) and for **AppImage or source builds**, install them from your distro's repos:

```bash
# Arch:          sudo pacman -S --needed qemu-system-x86 edk2-ovmf virtiofsd   # aarch64: qemu-system-aarch64 edk2-aarch64
# Fedora:        sudo dnf install qemu-system-x86 edk2-ovmf virtiofsd          # aarch64: qemu-system-aarch64 edk2-aarch64
# RHEL 9 / Rocky / Alma: sudo dnf install qemu-kvm edk2-ovmf virtiofsd
# Debian/Ubuntu: sudo apt install qemu-system-x86 ovmf virtiofsd               # arm64: qemu-system-arm qemu-efi-aarch64 · Ubuntu 22.04: no virtiofsd pkg needed (bundled copy is used)
```

**2. Join the `kvm` group** (once - then log out and back in):

```bash
sudo usermod -aG kvm "$USER"        # /dev/kvm access
```

The Claude Code CLI that Cowork/Dispatch drive is managed by the app itself - nothing to install. To pin your own binary, set `CLAUDE_CODE_LOCAL_BINARY=/path/to/claude`.

> A **system virtiofsd is required on everything except Ubuntu 22.x** - the app's capability probe only falls back to the bundled `virtiofsd` on jammy (`/etc/os-release` gate). Without it Cowork reports "Cowork requires QEMU …" even when qemu and firmware are present (issue #177). If your distro installs virtiofsd outside the probed paths (`/usr/libexec`, `/usr/lib`, `/usr/lib/qemu`, `/usr/bin`), point the app at it with `CLAUDE_VIRTIOFSD_PATH=/path/to/virtiofsd`; a custom firmware location can likewise be set with `CLAUDE_OVMF_CODE_PATH=/path/to/OVMF_CODE.fd` (its `*_VARS.fd` sibling must sit next to it). The Nix flake wires all three automatically (see the Nix install section).

> **Arch Linux ARM / EndeavourOS ARM / Manjaro ARM (native aarch64 host, e.g. Raspberry Pi 5):** `edk2-aarch64` is `arch=any` on archlinux.org but Arch Linux ARM's repos don't carry it, so `pacman -S edk2-aarch64` fails with `target not found` even after `-Syu` ([ALARM forum #16140](https://archlinuxarm.org/forum/viewtopic.php?t=16140)). Since the package is architecture-independent, grab it from the x86_64 Arch mirrors and install locally: `curl -L https://archlinux.org/packages/extra/any/edk2-aarch64/download -o edk2-aarch64.pkg.tar.zst && sudo pacman -U ./edk2-aarch64.pkg.tar.zst`.

## Distro and hardware notes

- **Debian 12 (bookworm): Cowork is not available.** Debian 12 has no package for the Rust `virtiofsd` the Cowork helper drives (neither in bookworm nor in bookworm-backports). Its `qemu-system-common` ships the older C `virtiofsd` at `/usr/lib/qemu/virtiofsd`, which does not accept the options the helper passes (`--shared-dir`), so the workspace VM cannot share your files. Debian 13 ships `virtiofsd`; the rest of the app works on Debian 12 unchanged.
- **Ubuntu 22.04 and Jetson (JetPack 6, Ubuntu 22.04 based):** no `virtiofsd` package is needed - on Ubuntu 22.x the app uses the copy bundled in the package.
- **RHEL 9 / Rocky / Alma:** `sudo dnf install qemu-kvm edk2-ovmf virtiofsd`. RHEL ships QEMU only as `/usr/libexec/qemu-kvm`, not as `qemu-system-<arch>` on `PATH` where the app looks for it, so the `.rpm` installs a `qemu-system-<arch>` shim pointing at it and the launcher adds the shim to `PATH` only when no `qemu-system-<arch>` is found and `/usr/libexec/qemu-kvm` exists. The `.rpm` recommends `qemu-system-<arch>` or `qemu-kvm`, so `dnf` pulls QEMU on RHEL too. Your user needs read/write access to `/dev/kvm` and `/dev/vhost-vsock`. The workspace VM is verified to boot on RHEL 9 x86_64; the aarch64 shim ships but is untested.
- **Raspberry Pi 5:** the workspace VM gets 4 GB of RAM by default, so Cowork needs the 8 GB (or larger) Pi 5; on a 4 GB board the VM does not fit next to the desktop and the app.
- **NVIDIA Jetson / DGX Spark:** Cowork needs `/dev/kvm`, and whether a board exposes it depends on its kernel build. Check with `ls -l /dev/kvm` and `claude-desktop --diagnose` before relying on Cowork there.

## Troubleshooting

Run **`claude-desktop --diagnose`** first - it prints a full capability probe (KVM, vhost_vsock, QEMU, firmware, virtiofsd) and tells you exactly which piece is missing. Common popups and their fixes:

- **"Download failed" / clicking Download does nothing** - almost always missing `kvm` group membership (`sudo usermod -aG kvm "$USER"`, then re-login), or on AppImage/Nix missing firmware or system virtiofsd.
- **"Virtualization isn't fully set up" / "Cowork requires QEMU. Install it with …"** - QEMU, OVMF firmware, or virtiofsd is missing. The popup's `apt` command is upstream's and only correct on Debian/Ubuntu - use your distro's command from [step 1 above](#setup) instead.
- **"Cowork requires the vhost_vsock kernel module"** - on systemd distros this normally never appears: systemd pre-creates `/dev/vhost-vsock` at boot (static device node) and the kernel auto-loads the module the moment QEMU opens it. If you do see it, you are on a non-systemd init (Artix, Void), inside a container, or on a kernel built without the module - load it with `sudo modprobe vhost_vsock` and persist it (`echo vhost_vsock | sudo tee /etc/modules-load.d/vhost_vsock.conf`, or your init's equivalent).
- **Dispatch stops responding or behaves oddly** - the Dispatch conversation keeps its state (including past errors) across restarts, so a broken session stays broken. Reset it: open the **⋮** menu next to the Dispatch title and click **Delete conversation**, then send your request again in the fresh conversation.

  ![Reset Dispatch: ⋮ menu, then Delete conversation](dispatch/reset-dispatch-conversation.png)

No symlinks or manual path configuration are needed: the capability probe searches the distro-native firmware and virtiofsd locations (`/usr/share/edk2/x64/OVMF_CODE.4m.fd`, `/usr/lib/virtiofsd`, …) out of the box. Custom locations can be set via `CLAUDE_OVMF_CODE_PATH` / `CLAUDE_VIRTIOFSD_PATH` (see above).

**CoworkSpaces** are stored locally per account under `~/.config/Claude/local-agent-mode-sessions/` (see [Known Limitations](../README.md#known-limitations)).

> **Note - Cowork does not work inside a nested VM.** Because Cowork boots its own lightweight VM (the bundled backend downloads/builds a rootfs and starts it via QEMU/KVM), it needs real, stable access to `/dev/kvm`. Running Claude Desktop inside a hypervisor guest (VirtualBox, VMware, etc.) means Cowork would have to launch a VM *inside* a VM (nested virtualization), which most desktop hypervisors do not support reliably - VirtualBox in particular can hard-crash the entire guest when the nested VM starts. The app itself installs and runs fine in a VM; only the Cowork feature requires a bare-metal host (or a cloud instance with nested virtualization properly enabled).
