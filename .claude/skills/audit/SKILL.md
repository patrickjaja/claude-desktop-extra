---
name: audit
description: Full review of the claude-desktop-extra project - patches vs the official Linux .deb (still needed? new ones needed? did the surrounding code change?), docs accuracy, Linux compatibility across the distro/session matrix, and runtime logs. Orchestrates a team of sub-agents and produces a consolidated report with solution approaches.
disable-model-invocation: true
---

# Audit - orchestrated project review

You are the **coordinator**. Spawn a team of sub-agents to review in parallel, then synthesize ONE report. Run from the repo root. `$ARGUMENTS` may scope the audit (e.g. "cowork only", "patches only"); default = full.

Use the `AskUserQuestion` tool (not limited to 4) whenever a finding needs the user's call. Read `/architecture` and `/linux` context first if unsure of the domain.

## Pre-flight (you do this before fan-out)
1. Ensure a **fresh unpatched** upstream extract exists for patch comparison: if `./tmp/app.asar.contents/.vite/build/index.js` is missing or older than today, run `/fresh-upstream` (or tell the user and run the manual .deb crack + asar flow). Patches must be judged against the true current upstream, not a stale extract.
2. Note `.upstream-version` vs the highest version in the official apt Packages index. Check `~/.config/Claude/logs/` exists for the log workstream.

## Fan out - spawn these workstreams as parallel agents (Explore/general-purpose)
Give each agent the project path, the fresh-extract path, and ask for **findings + file:line evidence + a recommended action**, not file dumps.

1. **Patches vs upstream.** For each `patches/*/*.nim`: does its target still exist in the fresh `./tmp` bundle? Run `./scripts/validate-patches.sh ./tmp/app.asar.contents` and report pass/fail. For failures, classify: pattern renamed / code refactored / feature removed / feature upstreamed (→ needs regression guard). Flag patches that may be **vestigial** (target gone, no longer needed) and **gaps** (new darwin/win32 gates with no Linux patch - diff `process.platform` old vs new). Verify `EXPECTED_PATCHES` strictness + no false-success idempotency (AGENTS.md Rule 6).
2. **Docs accuracy.** Cross-check `baseline/CLAUDE_FEATURE_FLAGS.md`, `CLAUDE_BUILT_IN_MCP.md`, `ION.md`, `PLATFORM_GATE_BASELINE.md`, `README.md` patch table, and `AGENTS.md` against the actual current bundle + patches. Flag stale minified names, wrong counts, removed features still documented. (Read `CHANGELOG.md` head only: offset 1, limit 60.)
3. **Linux compatibility.** Walk the support matrix (X11, Wayland-wlroots, Wayland-GNOME, Wayland-KDE, XWayland) × (Arch/Ubuntu/Debian/Fedora/RHEL/NixOS/Jetson, x86_64+aarch64). Check input (`js/cu_linux_executor.js`, `executor_linux.js`) + screenshot cascades still cover each session, the glibc floor (2.34 overall; kwin-portal-bridge 2.39) holds, launcher session detection is sound. Surface edge cases (ydotoold version, Niri, immutable distros, sandboxed/portal identity).
4. **Cowork backend (bundled native VM).** Cowork runs on the `.deb`'s bundled native VM backend (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF; requires `/dev/kvm`). The old `claude-cowork-service` Go daemon is deprecated and out of scope. Verify the Cowork-related `patches/*/*.nim` still match their targets in the fresh `./tmp` bundle and that any regression guards still assert the upstreamed behavior. Flag drift against the current bundle.
5. **Runtime logs (if present).** Scan `~/.config/Claude/logs/{main,cowork_vm_node,mcp,claude.ai-web}.log` for errors/exceptions, permission denials, dispatch bridge issues (`DISPATCH-FWD`/`DISPATCH-TRANSFORM`), and renderer crashes. `cowork_vm_node.log` is the bundled backend's Electron-side log (still valid). Defer deep dispatch/cowork debugging to `/debug`.

## Synthesize (you, after agents return)
Produce a report:
- **Summary table:** workstream → status (clean / needs attention / broken) → headline finding.
- **Patches:** vestigial (removable), at-risk (pattern drift), gaps (new Linux opportunities), each with file:line + recommended action.
- **Docs:** what's stale + the exact fix.
- **Linux matrix:** any session/distro/arch combo at risk.
- **Logs:** notable errors + likely cause.
- **Solution approaches:** ranked, with effort estimate. Use `AskUserQuestion` for any decision (delete a patch? add one? change behavior per backend?). When findings amount to upstream drift (stale patterns, new gates, protocol mismatch), the remediation path is `/update` - point there for the structured fix workflow.

Cross-reference memory (`~/.claude/projects/-home-patrickjaja-development-claude-desktop-extra/memory/`) for prior decisions before recommending changes. This is read-only review - propose, don't apply (unless the user then asks).
