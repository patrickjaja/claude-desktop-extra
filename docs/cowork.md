# Cowork on Linux: two backends

What Cowork and Dispatch need from the host, per backend and per distro, and what to do when a popup says something is missing. For the short version, see [Cowork setup in the README](../README.md#cowork-setup-needs-devkvm); for what Cowork itself is and how to use it, see Anthropic's official [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork).

## Two backends

| | Cloud Cowork | Local Cowork VM |
|---|---|---|
| Runs | In Anthropic's cloud | In a QEMU VM on this computer (bundled cowork-linux-helper + virtiofsd + smol-bin) |
| Available | claude.ai accounts only | claude.ai accounts (optional, when the host supports it) and third-party inference (the only Cowork there) |
| Needs on Linux | Sign-in. For desktop tools (Computer Use, files) this computer must be a **keyed device**: access to the TPM 2.0 resource manager `/dev/tpmrm0` | `/dev/kvm` and `/dev/vhost-vsock` access, QEMU, OVMF firmware, virtiofsd |
| Enable | Settings -> Extra -> Cowork (Linux) -> **Enable TPM access** | Settings -> Extra -> Cowork (Linux) -> **Enable KVM access** |
| Needs KVM | No | Yes |

The app chooses per task: "This task will run in the cloud" or "on your computer". Without KVM access the app hides the local option and a claude.ai account still gets cloud Cowork. Settings -> Extra -> **Cowork (Linux)** shows the state of both backends and Computer Use; `claude-desktop --diagnose` prints the same checks (sections "Cloud Cowork device key" and "Local Cowork VM").

In the header of every claude.ai chat and Cowork session (`/chat/...` and `/cowork/...`) a device icon shows where this desktop stands: the upstream laptop icon (with a "Linux details" row that opens Cowork (Linux)) when the chat is linked to this computer or runs in the local VM, a laptop with an X when this desktop has no device key (cloud tasks then can't use Computer Use here; files and commands still work), an amber dot when the desktop is keyed but this chat is not linked to it, and a plain laptop while the device key state is not known yet. Every variant opens the matching section of the page. Each popover also says where the chat runs: in the cloud (for a linked chat, its files and commands run in the linked computer's local Cowork VM) or in the local VM on this computer, with the VM's state.

## How Cowork chooses cloud or local

Facts as of app version 4.23118.0. Settings -> Extra -> Cowork (Linux) shows the same as a collapsible "How Cowork chooses where a task runs" block.

- **Two places.** Cloud: Anthropic's cloud VM. It reaches this computer's files and commands through the device link (they run in the local Cowork VM); Computer Use (screen and input) also needs the device key ([Cloud Cowork setup](#cloud-cowork-setup)). Local: the VM on this computer. It needs KVM ([Local Cowork VM setup](#local-cowork-vm-setup)), and it is the only option in 3P mode, where cloud Cowork is not available.
- **Which one a task uses:** the header icon tells you. A laptop marked "Connected" is a cloud task linked to this computer; a slashed cloud, "Only on this computer", is a local task.
- **Switching.** If your organization offers the choice, a cloud / local toggle (Beta) sits above the composer of a new task. Otherwise the app decides: a task with a local folder or Space, Dispatch, or an Auto or Skip-approvals mode the cloud cannot run, runs locally; plain chats and tasks run in the cloud. A running task can be moved with "Continue in cloud..." or back to this computer.
- **Organization admins** control this in claude.ai Admin settings: [Cowork](https://claude.ai/admin-settings/cowork) -> "Cowork in the cloud" (and "Chat and Cowork unified": when on, chat and Cowork are one surface and no separate toggle is shown), and [Capabilities](https://claude.ai/admin-settings/capabilities) -> Remote sessions -> "Computer access" and "Require trusted devices" (trusted devices = the device key).

## Local Cowork VM setup

The local backend is the **official native Cowork VM backend** bundled inside the package - the same one Anthropic ships in the official Linux build. There is no separate daemon to install; sessions run in a lightweight VM with `$HOME` shared in, which requires **`/dev/kvm`** and **`/dev/vhost-vsock`** on the host. Host loop sessions also run their shell commands in this VM.

**1. Install QEMU + UEFI firmware + virtiofsd.** The `.deb` / `.rpm` packages pull them automatically (`Recommends` / weak deps, matching Anthropic's official `.deb`), and the Nix flake bakes them into the app's closure. On **Arch** (pacman skips `optdepends`) and for **AppImage or source builds**, install them from your distro's repos:

```bash
# Arch:          sudo pacman -S --needed qemu-system-x86 edk2-ovmf virtiofsd   # aarch64: qemu-system-aarch64 edk2-aarch64
# Fedora:        sudo dnf install qemu-system-x86 edk2-ovmf virtiofsd          # aarch64: qemu-system-aarch64 edk2-aarch64
# RHEL 9 / Rocky / Alma: sudo dnf install qemu-kvm edk2-ovmf virtiofsd
# Debian/Ubuntu: sudo apt install qemu-system-x86 ovmf virtiofsd               # arm64: qemu-system-arm qemu-efi-aarch64 · Ubuntu 22.04: no virtiofsd pkg needed (bundled copy is used)
```

**2. Give your user access to `/dev/kvm` and `/dev/vhost-vsock`.** Pick one:

- **Settings -> Extra -> Cowork (Linux) -> Enable KVM access** (`.deb`, `.rpm`, pacman). After a confirmation it asks for an administrator password (polkit) and installs a udev rule that grants the logged-in desktop user access to both devices, plus a `modules-load.d` entry that loads `vhost_vsock` at boot. No relogin is needed; **restart the app** so it probes again. **Disable KVM access** in the same panel removes both. The rule applies to every account that logs in at this computer's screen, not only yours. On AppImage, or without a polkit agent, the panel shows the command to run with `sudo`.
- **NixOS:** `programs.claude-desktop-extra.kvmAccess.enable = true;` with `imports = [ claude-desktop-extra.nixosModules.default ];`, then rebuild.
- **kvm group** (any distro, once - then log out and back in):

```bash
sudo usermod -aG kvm "$USER"        # /dev/kvm access
sudo modprobe vhost_vsock           # if /dev/vhost-vsock is missing
```

The Claude Code CLI that Cowork/Dispatch drive is managed by the app itself - nothing to install. To pin your own binary, set `CLAUDE_CODE_LOCAL_BINARY=/path/to/claude`.

> A **system virtiofsd is required on everything except Ubuntu 22.x** - the app's capability probe only falls back to the bundled `virtiofsd` on jammy (`/etc/os-release` gate). Without it Cowork reports "Cowork requires QEMU …" even when qemu and firmware are present (issue #177). If your distro installs virtiofsd outside the probed paths (`/usr/libexec`, `/usr/lib`, `/usr/lib/qemu`, `/usr/bin`), point the app at it with `CLAUDE_VIRTIOFSD_PATH=/path/to/virtiofsd`; a custom firmware location can likewise be set with `CLAUDE_OVMF_CODE_PATH=/path/to/OVMF_CODE.fd` (its `*_VARS.fd` sibling must sit next to it). QEMU is looked up as `CLAUDE_QEMU_PATH` (an absolute path), then `/usr/bin/qemu-system-<arch>`, then `qemu-system-<arch>` on the app's `PATH`, so a QEMU in `/usr/local/bin` or another `PATH` dir is found too. The Nix flake wires all of these automatically (see the Nix install section).

> **Arch Linux ARM / EndeavourOS ARM / Manjaro ARM (native aarch64 host, e.g. Raspberry Pi 5):** `edk2-aarch64` is `arch=any` on archlinux.org but Arch Linux ARM's repos don't carry it, so `pacman -S edk2-aarch64` fails with `target not found` even after `-Syu` ([ALARM forum #16140](https://archlinuxarm.org/forum/viewtopic.php?t=16140)). Since the package is architecture-independent, grab it from the x86_64 Arch mirrors and install locally: `curl -L https://archlinux.org/packages/extra/any/edk2-aarch64/download -o edk2-aarch64.pkg.tar.zst && sudo pacman -U ./edk2-aarch64.pkg.tar.zst`.

## Distro and hardware notes

- **Debian 12 (bookworm): the local Cowork VM is not available.** Debian 12 has no package for the Rust `virtiofsd` the Cowork helper drives (neither in bookworm nor in bookworm-backports). Its `qemu-system-common` ships the older C `virtiofsd` at `/usr/lib/qemu/virtiofsd`, which does not accept the options the helper passes (`--shared-dir`), so the workspace VM cannot share your files. Debian 13 ships `virtiofsd`; the rest of the app works on Debian 12 unchanged.
- **Immutable Fedora (Bazzite, Silverblue, Kinoite, Aurora, Bluefin):** the image ships the firmware but neither QEMU nor virtiofsd; layer them and reboot: `rpm-ostree install qemu-system-x86 virtiofsd` (aarch64: `qemu-system-aarch64`). `claude-desktop --diagnose` then shows `qemuPath` and `virtiofsdPath` as found.
- **Ubuntu 22.04 and Jetson (JetPack 6, Ubuntu 22.04 based):** no `virtiofsd` package is needed - on Ubuntu 22.x the app uses the copy bundled in the package.
- **RHEL 9 / Rocky / Alma:** `sudo dnf install qemu-kvm edk2-ovmf virtiofsd`. RHEL ships QEMU only as `/usr/libexec/qemu-kvm`, not as `qemu-system-<arch>` where the app looks for it (`CLAUDE_QEMU_PATH`, `/usr/bin`, then the system folders and the root-owned read-only folders of the `PATH` it was started with), so the `.rpm` installs a `qemu-system-<arch>` shim pointing at it in `/usr/lib/claude-desktop/qemu-shim` and the launcher adds that folder to `PATH` only when no `qemu-system-<arch>` is found and `/usr/libexec/qemu-kvm` exists. The `.rpm` recommends `qemu-system-<arch>` or `qemu-kvm`, so `dnf` pulls QEMU on RHEL too. Your user needs read/write access to `/dev/kvm` and `/dev/vhost-vsock`. The workspace VM is verified to boot on RHEL 9 x86_64; the aarch64 shim ships but is untested.
- **Raspberry Pi 5:** the workspace VM gets 4 GB of RAM by default, so the local Cowork VM needs the 8 GB (or larger) Pi 5; on a 4 GB board the VM does not fit next to the desktop and the app.
- **NVIDIA Jetson / DGX Spark:** the local Cowork VM needs `/dev/kvm`, and whether a board exposes it depends on its kernel build. Check with `ls -l /dev/kvm` and `claude-desktop --diagnose` before relying on Cowork there.

## Cloud Cowork setup

Nothing to install and no KVM needed. Sign in with a claude.ai account and open a Cowork task that runs in the cloud. To let those tasks use this computer's Computer Use (screen and input), the desktop must register with a TPM-backed device key; files and commands work without it: Settings -> Extra -> Cowork (Linux) -> **Enable TPM access**, then restart Claude and start a new task. Details, security notes and the NixOS option: [Computer Use in cloud Cowork and Dispatch](computer-use.md#computer-use-in-cloud-cowork-and-dispatch). A computer without a TPM 2.0 still gets cloud Cowork, just without Computer Use on this computer.

## Troubleshooting

Run **`claude-desktop --diagnose`** first - the "Local Cowork VM" section is a full capability probe (KVM, vhost_vsock, QEMU, firmware, virtiofsd) and tells you exactly which piece is missing; "Cloud Cowork device key" covers the TPM. Common popups and their fixes:

- **"Download failed" / clicking Download does nothing** - almost always missing KVM access (Settings -> Extra -> Cowork (Linux) -> Enable KVM access, then restart the app; or `sudo usermod -aG kvm "$USER"` and re-login), or on AppImage/Nix missing firmware or system virtiofsd.
- **"Virtualization isn't fully set up" / "Cowork requires QEMU. Install it with …"** - QEMU, OVMF firmware, or virtiofsd is missing. The popup's `apt` command is upstream's and only correct on Debian/Ubuntu - use your distro's command from [step 1 above](#local-cowork-vm-setup) instead.
- **"Cowork requires the vhost_vsock kernel module"** - on systemd distros this normally never appears: systemd pre-creates `/dev/vhost-vsock` at boot (static device node) and the kernel auto-loads the module the moment QEMU opens it. If you do see it, you are on a non-systemd init (Artix, Void), inside a container, or on a kernel built without the module - load it with `sudo modprobe vhost_vsock` and persist it (`echo vhost_vsock | sudo tee /etc/modules-load.d/vhost_vsock.conf`, or your init's equivalent).
- **No "run on your computer" option in Cowork** - the app found the local VM unsupported (no `/dev/kvm` or `/dev/vhost-vsock` access, or QEMU, firmware or virtiofsd missing) and offers cloud Cowork only. Fix the item the Local Cowork VM section of Settings -> Extra -> Cowork (Linux) or `--diagnose` names, then restart the app: it probes once at start.
- **Dispatch stops responding or behaves oddly** - the Dispatch conversation keeps its state (including past errors) across restarts, so a broken session stays broken. Reset it: open the **⋮** menu next to the Dispatch title and click **Delete conversation**, then send your request again in the fresh conversation.

  ![Reset Dispatch: ⋮ menu, then Delete conversation](dispatch/reset-dispatch-conversation.png)

No symlinks or manual path configuration are needed: the capability probe searches the distro-native firmware and virtiofsd locations (`/usr/share/edk2/x64/OVMF_CODE.4m.fd`, `/usr/lib/virtiofsd`, …) out of the box. Custom locations can be set via `CLAUDE_OVMF_CODE_PATH` / `CLAUDE_VIRTIOFSD_PATH` (see above).

**CoworkSpaces** are stored locally per account under `~/.config/Claude/local-agent-mode-sessions/` (see [Known Limitations](../README.md#known-limitations)).

> **Note - Cowork does not work inside a nested VM.** Because Cowork boots its own lightweight VM (the bundled backend downloads/builds a rootfs and starts it via QEMU/KVM), the local VM needs real, stable access to `/dev/kvm`. Running Claude Desktop inside a hypervisor guest (VirtualBox, VMware, etc.) means Cowork would have to launch a VM *inside* a VM (nested virtualization), which most desktop hypervisors do not support reliably - VirtualBox in particular can hard-crash the entire guest when the nested VM starts. The app itself installs and runs fine in a VM; only the local Cowork VM requires a bare-metal host (or a cloud instance with nested virtualization properly enabled).
