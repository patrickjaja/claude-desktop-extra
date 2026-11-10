---
name: architecture
description: Explains the purpose, features, and architecture of claude-desktop-extra - which repackages Anthropic's official Claude Desktop Linux .deb for Arch/Fedora/RHEL/Nix/AppImage and layers Linux-only extras (Computer Use, themes, multi-profile, Quick Entry) on top via surgical JS patches. Use when onboarding, writing docs/READMEs, explaining what the project does, or reasoning about how the official build and our patches fit together.
when_to_use: When the user asks what the project does, how the pieces fit, what we add on top of the official build, the USPs, or wants an architecture/overview explanation for docs or a new contributor.
---

# Architecture - claude-desktop-extra

Repackages Anthropic's **official Claude Desktop Linux `.deb`** for the distros Anthropic does not ship (Arch via our own pacman repo, Fedora/RHEL, NixOS, AppImage) and for our own Debian/Ubuntu `.deb`, while layering a small set of **Linux-only value-adds** that the official build does not provide. See `/linux` for compat specifics.

## What we start from: the official Linux .deb
Anthropic publishes an official Claude Desktop build for Linux as a `.deb` in an apt repo (`https://downloads.claude.ai/claude-desktop/apt`). It bundles its own Electron (44.9.3 as of v4.23118.0; authoritative: the deb's `usr/lib/claude-desktop/version`) and ships a **native Cowork VM backend** (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF; the local VM requires `/dev/kvm` and `/dev/vhost-vsock`). The official build natively supports Chat, Code and Cowork, ships a staged Linux Computer Use rollout (portal-based, GNOME 46+ / current Plasma, no wlroots), and reads managed config from `/etc/claude-desktop/managed-settings.json`. We do **not** patch the Windows MSIX any more - that pipeline is gone.

## What this repo does: ingest -> patch -> repackage
**Ingest:** download the official `.deb` (apt repo, or `--deb PATH`/`--version X`) -> verify GPG + SHA256 -> `dpkg-deb -x` -> locate `usr/lib/claude-desktop/resources/app.asar` -> `asar extract`.
**Patch:** run `scripts/apply_patches.py` (the orchestrator) over the extracted bundle. **70** surgical JS patches (`patches/{linux,community,core}/*.nim`: 38 Linux fixes + 9 core plumbing, always on; 23 community features, opt-in, compiled native binaries, regex on minified JS) apply Linux-only fixes and our value-adds. The official build re-minifies between releases, so patterns use `[\w$]+` wildcards anchored on stable strings (feature names, log messages, `process.platform==="darwin"`), count `EXPECTED_PATCHES`, and `quit(1)` on any miss. `.upstream-version` records the last validated version.
**Repackage:** `asar pack` (preserving `app.asar.unpacked`, which carries the official build's pre-built native modules - we no longer rebuild node-pty) into a tarball, then build the pacman package/our-own-deb/rpm/AppImage/Nix from it.

Several patches that used to *enable* Cowork on Linux (the "cowork-wiring" cluster) were **removed** once the official build started shipping Cowork natively; assert-only regression guards were retired on 2026-07-15 (AGENTS.md Rule 4): only patches that change the bundle remain, and the absorption probe (`scripts/check-upstream-absorbed.py`) flags a patch whose end state upstream now ships.

## Value-adds we layer on top (the reason this repo exists)
- **Computer Use** - desktop automation (screenshot/click/type/scroll); session-aware backends (`fix_computer_use_linux` + bundled `kwin-portal-bridge`). On for every account and session type; the official build's own Linux Computer Use is a staged portal-based rollout that skips wlroots, and our bundled bridges (x11, wlroots, gnome-portal, kwin-portal) take precedence. See `/linux` for the input/screenshot cascades.
- **Custom themes** - dual light/dark built-in palettes (`add_feature_custom_themes`).
- **Multi-profile instances** - run several Desktops side by side via `CLAUDE_PROFILE` (`fix_profile_*`).
- **Quick Entry** - global hotkey popup, multi-monitor + Wayland-safe (`fix_quick_entry_*`).

**Features the app exposes that the official build already provides (we just preserve them through the repackage):**
- **Chat** - main conversational UI.
- **Claude Code** - auto-detects system `claude` CLI; Code tab + integrated terminal.
- **Cowork** - delegate a goal to a sandboxed Claude Code agent that reads/edits/creates files and returns a deliverable. Runs on the **official native Cowork VM backend** bundled in the `.deb` (no separate daemon needed) for its local VM; the local VM requires `/dev/kvm`. Cowork has two backends: cloud Cowork (1P only; no KVM, desktop tools need a keyed device = TPM access) and the local Cowork VM (optional in 1P, the only Cowork in 3P). Settings -> Extra -> Cowork (Linux) shows both.
- **Browser Tools** - Chrome automation via the Claude-in-Chrome extension/MCP.
- **3P / Enterprise gateway** - configure external inference (Bedrock/Vertex/Azure/gateway); managed config from `/etc/claude-desktop/managed-settings.json`; ion-dist 3P-config SPA.
- **Imagine** - in-Cowork image generation.

`baseline/` tracks version-sensitive internals (re-validate each release): `CLAUDE_FEATURE_FLAGS.md` (flag catalog, GrowthBook IDs, 3-layer override), `CLAUDE_BUILT_IN_MCP.md` (internal MCP servers), `ION.md` (3P-config SPA stats/hashes), `PLATFORM_GATE_BASELINE.md` (every darwin/win32 gate classified PATCHED/NATIVE/STUB/PORTABLE).

## claude-cowork-service - DEPRECATED
Historically this project shipped a sibling Go daemon (`claude-cowork-service`, binary `cowork-svc-linux`) that filled the role the macOS/Windows VM layer plays for Cowork: it reverse-engineered the length-prefixed-JSON-over-Unix-socket RPC protocol and ran the `claude` CLI either directly on the host (native mode) or in a QEMU/KVM guest. **It is now deprecated/archived.** The official Linux `.deb` bundles its own native Cowork VM backend, so the daemon is no longer needed or installed. Existing references in `baseline/` and `CHANGELOG.md` are historical record.

## USPs
**Project vs the official build:** brings Claude Desktop to the distros Anthropic does not package (Arch, Fedora/RHEL, Nix, AppImage); adds **Computer Use** on every session type (ahead of the official build's staged portal rollout), custom themes, multi-profile, and Quick Entry; open source.

## How it fits
```
Anthropic official Claude Desktop Linux .deb  (own Electron + native Cowork VM backend)
        │  download → verify GPG+SHA256 → dpkg-deb -x → asar extract
        ▼
claude-desktop-extra  (70 JS patches: 47 always-on Linux fixes + core plumbing, 23 opt-in community features)
        │  asar pack → tarball
        ▼
our pacman repo / our .deb / .rpm / .AppImage / Nix
```
