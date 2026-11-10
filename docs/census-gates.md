# Census gates

Two build gates guard against an upstream release that adds a Linux/Wayland decision our patches do not cover. Both run in `scripts/build-patched-tarball.sh` after patching (local builds and CI) and need a **patched** tree; they share the lexer `scripts/census_lex.py`. The baselines are edited by hand.

```bash
python3 -I scripts/check-predicate-consumers.py <patched tree>   # baseline/predicate-consumers.json
python3 -I scripts/check-refusal-strings.py <patched tree>       # baseline/refusal-strings.json (--strict: warnings fail too)
```

`<patched tree>` is the directory `apply_patches.py` patched (the one holding `.vite/build/index*.js`). Both exit 0 when green.

## Predicate census (`baseline/predicate-consumers.json`)

Every consumer of the tracked upstream session and Computer Use predicates (followed through export aliases, lazy requires, destructured members and derived values) must be covered by our injected shape or be a reviewed allowlist entry. Raw session-test occurrences must be tracked, ours or pinned.

- `predicates[].definitionShape`: regexes anchored at the definition's body that match OUR injected start or `||` operand. A match covers the predicate at its definition, so every alias. Only our exact injected text belongs here.
- `predicates[].transitiveIgnore`: callees (matched by body shape) that cannot decide the result on Linux, each with a reason. A predicate is transitively covered only when its body is nothing but covered tracked calls and listed callees joined by boolean operators.
- `coveredSites`: our exact injected shape around one consumer, `@@` where the consumer's reference sits, a pinned `consumers` count and a reason. `decides: "opt-in"` marks injections where our term decides only while a user switch is on (reported as `opt-in-site`).
- `allowlist`: consumers that stay upstream on purpose. Each has a stable anchor (a string literal, a log tag or an un-minified namespace name; `anchorRegex` for a `[\w$]+` shape), a `scope` (`function`, the default, or `statement`), a pinned `consumers` count, a verdict (`intentional`, `upstream-ok` or `open`; `open` requires an `issue`) and a reason. `via`: omitted = the root predicate's own consumers; `"derived"` = consumers of any derived value; `"<NAME>"` = consumers of the derived value exported under that un-minified name.
- `envSites`: upstream occurrences of `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `XDG_CURRENT_DESKTOP` or `ozone-platform` outside every tracked definition and outside our injected code: token, anchor or `anchorRegex`, scope, count, reason. Text counts as ours for the raw session-test check only when both sides of the token match our injected sources; boundary cases are pinned in `envSites`.

## Refusal census (`baseline/refusal-strings.json`)

Every upstream Linux/Wayland/Xorg/platform refusal string is pinned with a status. `scripts/check-refusal-strings.py` separates what breaks a build from what only needs a refresh.

It fails (exit 1) on: a new refusal string naming a strong topic (Linux, Wayland, Xorg/X11/X server/display server, portal, session type, "this platform"/"unsupported platform", Computer Use); a `neutralised` pin whose `verify` injection no longer matches the bundle (the patch that made it true regressed); and a `neutralised` or `unreachable` pin printed at a different number of sites. A missing or malformed baseline exits 2.

It warns (`[WARN]` lines, exit 0) on: a new string that names only a weak topic (this device / computer / system, macOS, "only available on", "not supported on"); a stale pin (upstream dropped the string); and an `accepted` pin printed at a different number of sites. Warnings are not silent drift: the summary line counts them, the block ends with a reminder to refresh the pins, and the /update skill runs the check with `--strict`, which turns every warning into a failure. The predicate census has no warn level: every finding fails.

- `id`: the first 12 hex digits of the sha1 of `text`.
- `text`, `sites` (how many places carry it), `reason`.
- `status`: `neutralised` (our patch makes it unreachable or rewrites it; needs `verify {regex, count}` proving that in the patched tree), `unreachable` or `accepted`.

## Loosening

A loosening edit needs `@patrickjaja` in the commit: adding or widening an `allowlist`, `coveredSites`, `envSites` or `transitiveIgnore` entry or a `definitionShape`; raising a pinned count; switching to `decides: "opt-in"` or `via: "derived"`; adding an `accepted` refusal pin or raising `sites`. Removing stale entries tightens.

## What the checks cannot see

The settings SPA (`ion-dist.asar`), remote claude.ai code, computed property names, values passed as arguments, and run-time-assembled text.

## When a census is red after an upstream bump

- A new consumer or string: read the new code path and patch it (prefer the definition), or add a reviewed entry.
- A stale anchor or shape: re-fit it like a patch anchor.
