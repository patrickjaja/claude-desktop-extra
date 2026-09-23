# Constraints

Last reviewed: 2026-09-23 by @patrickjaja, against upstream 2.7032.0.

This repo is not a normal codebase. It patches a bundle Anthropic re-minifies
every release, and Anthropic is working on the same Linux gaps in parallel. So
the bar is not a coverage percentage. It is: **every patch changes something
real, applies completely, or fails the build loudly.** A green build that
carries a patch doing nothing is the failure mode these constraints exist to
stop.

Agents: read this before touching `patches/`, `js/` or `scripts/`. Never weaken
a rule, lower a count, or add an exception to make a change pass. Tightening
is silent; loosening needs @patrickjaja in the commit.

## Floor (always enforced, blocks the build)

| ID | Rule | Why | Checked by | Runs at |
|----|------|-----|-----------|---------|
| P0 | Every sub-patch applies, or the patch exits 1 | A pattern that stopped matching means upstream moved. Silence ships a broken feature (AGENTS.md Rule 5b) | each patch's `EXPECTED_PATCHES` counter; `python3 scripts/apply_patches.py` exits 1 | every build (local + CI) |
| P1 | Every patch changes the pristine bundle. No sub-patch may find its end state already present upstream | If upstream shipped it, the patch is dead weight that still has to be re-fitted every release (AGENTS.md Rule 4) | `python3 scripts/check-upstream-absorbed.py` -> ABSORBED / PARTIAL | every build (local + CI), before patches apply |
| P2 | Every patch is idempotent through a positive end-state check: run on its own output, it exits 0 and changes nothing | Without it the probe cannot see absorption for that patch, and "already patched" can be a lie (Rule 3/6) | same probe, second run of each patch | every build |
| P3 | A patch writes only its own `@patch-target` | The orchestrator stages each target alone; a sibling write is a silent no-op (shipped index.pre.js unpatched in v1.15200) | `bash scripts/check-patch-sibling-noop.sh` | CI |
| P4 | Discovered counts match the pinned counts, and a pin only changes in the commit that adds or `git rm`s the file | Stops a bad glob or a lost file from shrinking what runs while staying green | `EXPECTED_PATCH_COUNT` in `scripts/apply_patches.py`, `EXPECTED_TEST_HARNESSES` in `scripts/run-feature-tests.sh` | every build / CI |
| P5 | Every patched JS part parses | A half-replaced construct boots to a white window | `node --check` per chunk in `scripts/build-patched-tarball.sh` | every build |
| F0 | This file does not get weakened to make a change pass | A gate that moves when hit is not a gate | review of `git diff CONSTRAINTS.md` | review |

### What a P1 failure means, and what it does not

- **ABSORBED / PARTIAL -> audit deeply, then remove.** Confirm upstream ships
  the *same behavior on Linux*, not just a string that looks like our end
  state: read the new code path, check the platform gate, spot-check a real
  install if it is user-visible. Then `git rm` the patch (or drop the
  sub-patch), bump `EXPECTED_PATCH_COUNT`, update `PATCHES.md`, and note it in
  `CHANGELOG.md`. Never delete on the probe's verdict alone.
  ABSORBED can also mean an earlier patch of ours already produces the same
  result - that is a redundant patch, same treatment.
- **FAILED is not a removal signal.** A patch that no longer finds its target
  is re-fitted (the target moved) unless the audit shows the feature was
  upstreamed. The probe reports FAILED for context only; `apply_patches.py`
  fails the build on it with the real error.
- **Never convert a dead patch into an assert-only guard.** That is still a
  patch that changes nothing (Rule 4, retired 2026-07-15).

## Enforced with tools

| Dimension | Rule | Checked by | Runs at | Kind |
|-----------|------|-----------|---------|------|
| Upstream integrity | Official `.deb` matches the pinned Anthropic apt key, GPG + SHA256 | `Verify Anthropic apt signing key fingerprint` + download steps in `build-and-release.yml` | CI | external |
| Upstream absorption | P1/P2 above | `check-upstream-absorbed.py` against the pristine extract | every build | external (upstream's bundle is the judge) |
| Nim format | Zero `nph` diffs on staged patches | `nph --check <staged .nim>` | pre-commit (`.githooks/pre-commit`) | project |
| Nim compile | Every patch compiles | `nim check --hints:off` (pre-commit), `bash scripts/compile-nim-patches.sh` (CI) | pre-commit, CI | project |
| Shell | Zero shellcheck errors | `shellcheck -S error scripts/*.sh packaging/*/*.sh .github/scripts/*.sh` | pre-commit (staged), CI (all) | external |
| Feature behavior | All 29 harnesses PASS or SKIP (exit 3 only for a missing tool) | `bash scripts/run-feature-tests.sh` (full suite ~141 s, so one category at task end) | task end (touched category), CI (all) | suite |
| Desktop entries | Zero `desktop-file-validate` warnings | `Validate .desktop files` step | CI | external |
| Docs catalog | `docs/claude-desktop-extra.jsonc` matches the shipped template | `bash scripts/check-jsonc-template-sync.sh` | CI | project |

### Where each check runs

| Stage | Commands | Budget |
|-------|----------|--------|
| Edit / commit | `.githooks/pre-commit` (nph, nim check, shellcheck on staged files) | seconds |
| Task end (any change under `patches/` or `js/`) | `cd patches && make -j"$(nproc)"`, then `python3 scripts/check-upstream-absorbed.py tmp/app.asar.contents tmp/extract/usr/lib/claude-desktop/resources/ion-dist` (~13 s, against a fresh extract, see AGENTS.md), then `bash scripts/run-feature-tests.sh <community\|core\|linux>` for the category you touched | under 90 s |
| Build (local + CI) | `scripts/build-patched-tarball.sh` runs the probe, the orchestrator, and `node --check` | part of the build |
| CI | everything above (full harness suite) plus sibling-noop, jsonc sync, desktop-file-validate, smoke test | unlimited |

## Measured, not yet enforced

| Metric | Today (2.7032.0) | Direction | Why it is not a gate |
|--------|------------------|-----------|---------------------|
| Patch count | 50 | should fall over time | Falling is the goal, but a new real Linux gap is a valid reason to add one |
| Patches passing P2 without an exception | 50 of 50 | must not fall | Not a gate yet: a new exception row is still possible (see below) |
| Probe runtime | ~11 s (50 patches, each run twice) | watch | Moves to CI-only if it passes 60 s |
| Full harness suite runtime | ~141 s | watch | Over the task-end budget, hence category-scoped locally |

## Exceptions

Rows with rule `P2-idempotent` are read by `check-upstream-absorbed.py`. An
expired row fails the build. A patch that becomes idempotent while its row
still exists also fails, so the row gets deleted.

| ID | Rule | Path | Reason | Owner | Expires |
|----|------|------|--------|-------|---------|
