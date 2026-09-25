# Project skills

[Claude Code skills](https://code.claude.com/docs/en/skills) for working on **claude-desktop-extra** (the Linux-patched repackage of Anthropic's official Claude Desktop Linux `.deb`). Each skill is a folder with a `SKILL.md` (YAML frontmatter + instructions). They load automatically because they live in `.claude/skills/` under the repo - no install step. Edits take effect live (no restart).

These are project-scoped on purpose: they encode *this* project's quirks (a remotely-managed official Linux `.deb` that re-minifies every release, a wide distro/session-manager matrix, Cowork on the `.deb`'s bundled native VM backend). They're committed so the knowledge is shared and survives across machines and contributors.

## What a skill actually does

A skill is more than a saved prompt:

- **Context injection on demand.** A skill's body is *not* in context until it's used - only its one-line `description` is. When invoked (by you or by Claude), the full body loads as a message and stays for the rest of the session. So a long reference (like `/linux`) costs almost nothing until something makes it relevant.
- **Two trigger modes** (set per skill via `disable-model-invocation`):
  - **Auto-inject** - Claude loads it on its own when your request matches the `description`/`paths`. Used for *reference* skills (`/linux`, `/architecture`).
  - **Manual only** (`disable-model-invocation: true`) - only runs when you type `/name`. Used for *action* skills with side effects, so Claude never e.g. deploys or wipes extracts on its own.
- **Path scoping** (`paths:`) - `/linux` also auto-loads whenever Claude touches `patches/`, `scripts/`, or `js/`, even if you didn't mention Linux.
- **Dynamic context** - a `` !`cmd` `` line in a skill runs *before* Claude sees the body and inlines the output. `/deploy` uses this to show the current branch, tracked version, and recent CI runs up front.
- **Orchestration / args** - a skill body can instruct Claude to spawn a sub-agent team (`/audit`) or consume arguments (`/deploy force`, `/debug <what broke>`).
- **Sparse, deliberate cross-links** - skills point at each other only at a real handoff (a command the body actually runs, or a decision fork it just computed), never for "completeness." Pointers *into* the two auto-injecting references (`/linux`, `/architecture`) are mostly omitted on purpose: the harness already pulls them when relevant, so an extra "see `/linux`" is just recurring token cost. See **How the skills connect** below.

## The skills

| Skill | Trigger | Use it when… |
|---|---|---|
| `/linux` | auto (also on `patches/`,`scripts/`,`js/` edits) | working on Linux compatibility |
| `/architecture` | auto / manual | you need the big picture of either project |
| `/3p` | auto (also on enterprise/ion-dist patch edits) | working on managed-settings.json, an inference gateway, or the Claude-3p deployment |
| `/audit` | manual | you want a full project review |
| `/deploy` | manual | you want to ship a release |
| `/update` | manual | a new upstream Claude Desktop version dropped |
| `/fresh-upstream` | manual | you need a clean unpatched bundle to inspect |
| `/debug` | manual | something is broken and you need the evidence |
| `/comment` | manual | you want to reply to an issue reporter and ask for the evidence we still need |

### How the skills connect

The three **reference** skills (`/linux`, `/architecture`, `/3p`) hold durable domain knowledge and auto-inject; the six **action** skills consume them. The wiring is intentionally minimal - these are the links that earn their place:

```
fresh-upstream ──▶ update ──▶ deploy        new-version pipeline
       ▲             ▲ │
  audit ┘     debug ──┘ └─ (patched feature misbehaves → debug)
       └──────────────────▶ update          audit finds drift → remediate
```

- `update` runs `/fresh-upstream` (Step 1) and ends with `/deploy` (Step 9).
- `fresh-upstream` branches on its result → `/update` (new version) or `/audit` (just refreshing).
- `audit` finds drift → `/update`; defers deep log work → `/debug`.
- `debug` bottoms out at a patch/upstream cause → `/fresh-upstream` + `/update`.
- `deploy` redirects version/patch work → `/update` (it only fires the pipeline).
- `debug` runs out of local evidence → `/comment` asks the reporter for theirs; `deploy` ships a fix for an issue → `/comment` tells them what to upgrade to and what to send back.
- `/linux` ↔ `/architecture` link each other (complementary references); `/debug` cites both because, being manual-only, it won't auto-pull them and genuinely needs the CU cascade + Cowork backend context.

### `/linux` - Linux compatibility reference
**What:** Loads the distro/session-manager support matrix, the Computer Use input + screenshot cascades (sourced from `js/cu_linux_executor.js`), native-binary glibc floors, multi-profile/window-identity rules, and the catalogue of known Linux gotchas mapped to their patches.
**When:** Any Linux-compat work - Wayland/X11, a specific distro, input/screenshot backends, glibc, node-pty, profiles. It auto-injects when you edit patch/script/js files, so you usually don't invoke it by hand.
**Why:** The hard part of this project is the combinatorial matrix (5 session types × 8 distros × arch). This keeps those edge cases in front of Claude instead of rediscovered each time.

### `/architecture` - what the project is
**What:** Explains the purpose and user-facing features of the repo, how the official `.deb` and our patches fit together, the `.deb`'s bundled native Cowork VM backend, and our Linux-only value-adds.
**When:** Onboarding, writing docs/READMEs, or any time you're reasoning about how the official build and our patches fit together.
**Why:** Grounds explanations in the real design (official build + patches) rather than guesses.

### `/audit` - orchestrated full review
**What:** Makes Claude the coordinator of a sub-agent team that reviews, in parallel: patches vs the current official `.deb` (still needed? new gaps? did surrounding code move?), docs accuracy, the Linux matrix, and runtime logs - then synthesizes one report with ranked solutions. Pre-flights a fresh extract first. Read-only: it proposes, it doesn't apply.
**When:** Periodically, or when you suspect drift after upstream churn.
**Why:** Heavier but thorough; the right tool when "is everything still correct?" matters.

### `/deploy` - trigger the release pipeline
**What:** Shows branch + tracked version + recent runs, then fires `build-and-release.yml` via `gh workflow run` and reports the run URL. `/deploy force` sets `force_rebuild=true` (release even when the upstream version is unchanged - for patch/feature-only updates).
**When:** You're ready to ship.
**Why:** Manual-only and one command, with the force toggle made explicit.

### `/update` - handle a new upstream version
**What:** The end-to-end workflow from [issue #145](https://github.com/patrickjaja/claude-desktop-extra/issues/145): build → fix failing patches → diff old/new JS for new platform gates → feature-flag + ion-dist + platform-gate audits → update baseline docs + CHANGELOG → bump `.upstream-version` → commit. Self-contained: it is the only copy of the manual update procedure.
**When:** A new Claude Desktop version is detected.
**Why:** Turns the most error-prone recurring task into a guided, strict checklist (every sub-patch must pass or fail loudly).

### `/fresh-upstream` - clean unpatched extract
**What:** Wipes old extract dirs, fetches + GPG/SHA256-verifies the latest official `.deb` if missing/stale, and extracts a **clean, unpatched** bundle into `./tmp/` by cracking the `.deb` (`dpkg-deb -x`) + `asar extract` - deliberately *not* the build script, which applies patches.
**When:** Before patch debugging or an audit, so you compare against true upstream (stale extracts have different minified names → wrong conclusions).
**Why:** A reliable pristine baseline in one step.

### `/debug` - collect evidence, then diagnose
**What:** `/debug <what's broken>` pulls the newest `local-agent-mode-sessions/.../audit.jsonl` (your last prompt + the model's tool calls/errors - the source of truth for Cowork/Dispatch runs), greps whichever `~/.config/Claude/logs/` files exist (including the bundled backend's `cowork_vm_node.log`), then asks you for anything else the specific issue needs before forming a hypothesis.
**When:** A feature misbehaves and you want it grounded in real logs, not speculation.
**Why:** Encodes the dispatch/cowork debug workflow from `AGENTS.md` so the right evidence is gathered every time.

## Conventions for editing / adding skills

- Folder name = command name (`fresh-upstream/` → `/fresh-upstream`). Frontmatter `name:` must match the folder.
- Keep `description` + `when_to_use` under 1,536 chars combined (it's truncated in the listing); put the key use case first.
- Keep the body concise (target < 500 lines) - once invoked it stays in context, so every line is a recurring token cost. State what to do, not why at length.
- Use `disable-model-invocation: true` for anything with side effects (deploy, wipe, commit) so it's manual-only.
- Reference minified upstream internals only via `[\w$]+`-style descriptions and note the version - names change every release.
- Cross-reference another skill only where it pays off: a command the body actually runs, or a fork the skill just decided. Don't add a link just to mirror an existing one, and don't point at `/linux` or `/architecture` from a skill that already auto-injects them - let the mechanism do it (exception: manual-only skills like `/debug` that need that context but won't trigger the auto-inject).
- This README is documentation, not a skill (no `SKILL.md`), so it is ignored by skill discovery.

`.claude/settings.local.json` is intentionally git-ignored (machine-local); only `.claude/skills/` is tracked.
### `/comment` - reply to an issue reporter
**What:** Reads the issue thread, then drafts a reply in the house voice: short, factual, friendly, one copy-pasteable command block, at most one bolded question. Prints the draft and stops; posts via `gh issue comment --body-file` only after you approve.
**When:** A reporter needs an answer, or a release shipped something they should test.
**Why:** The rules are the point - no attributing the cause to our own patches, no reproduction narratives, no speculation, no correcting their diagnosis unless they need it to gather the right data. The goal is that they send facts back, and everything that doesn't serve that gets deleted.

