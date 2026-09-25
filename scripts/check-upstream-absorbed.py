#!/usr/bin/env python3
"""Challenge every patch's right to exist against a pristine upstream bundle.

WHY THIS EXISTS
---------------
Anthropic works on Linux support in parallel with us. Any release can ship,
natively, something one of our patches used to add. A strict patch does not
fail when that happens: its "already patched" branch sees the end state and
reports success, so the build stays green while we carry a patch that does
nothing. AGENTS.md Rule 4: every patch must change the bundle.

This probe replays the orchestrator's sequence (same basename order, same
chunk concatenation) against a PRISTINE extract and classifies each patch:

  ABSORBED  exit 0, changed zero bytes. Upstream (or an earlier patch of ours)
            already produces the end state. BLOCKS. Audit, then git rm.
  PARTIAL   changed bytes, but a sub-patch took its "already" branch. BLOCKS.
            Audit that sub-patch, then drop it from the patch.
  ACTIVE    changed bytes, no "already" branch taken.
  FAILED    non-zero exit. NOT this probe's verdict: a target that moved is
            re-fitted, never removed, and apply_patches.py fails the build on
            it with the real error. Reported for context only.

It also re-runs every ACTIVE patch on its own output (AGENTS.md Rule 6): the
second run must exit 0 and change nothing. That is what makes ABSORBED
detectable for that patch at all - a patch without a working "already" branch
turns an upstreamed feature into a red build instead of a verdict here.
Known violators are listed in IDEMPOTENCY_EXCEPTIONS below; an expired entry
fails like a violation, and an entry for a patch that became idempotent fails
too, so the list only ever shrinks back to empty.

Exit codes: 0 = clean, 1 = ABSORBED/PARTIAL/P2 violation or expired exception,
2 = could not run (bad args, missing binaries, extract already patched).

Usage:
  scripts/check-upstream-absorbed.py [--patches DIR] <app.asar.contents> [<ion-dist>]
  scripts/check-upstream-absorbed.py tmp/app.asar.contents \\
      tmp/extract/usr/lib/claude-desktop/resources/ion-dist
"""

import datetime
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_patches as ap

REPO = Path(__file__).resolve().parent.parent
# A sub-patch that found its end state in the input. Tag words vary across the
# patches ([OK]/[INFO]/[PASS]/[SKIP]), the word "already" does not.
ALREADY = re.compile(r"^\s*\[(OK|INFO|PASS|SKIP)\].*\balready\b", re.I)
# Patches allowed to fail the idempotency re-run, until the date given.
# {patch basename without .nim: (exception id, "YYYY-MM-DD" expiry)}
# Adding an entry loosens the gate: it needs @patrickjaja in the commit.
IDEMPOTENCY_EXCEPTIONS: dict[str, tuple[str, str]] = {}


def sha(path: Path) -> bytes:
    return hashlib.sha256(path.read_bytes()).digest()


def dir_digest(root: Path) -> bytes:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(root)).encode())
            h.update(p.read_bytes())
    return h.digest()


def run(bin_path: Path, target: Path):
    r = subprocess.run([str(bin_path), str(target)], capture_output=True, text=True)
    out = (r.stdout + r.stderr).splitlines()
    return r.returncode, [ln.strip() for ln in out if ALREADY.match(ln)]


def main():
    args = sys.argv[1:]
    patches_dir = REPO / "patches"
    if args[:1] == ["--patches"] and len(args) >= 2:
        patches_dir = Path(args[1]).resolve()
        args = args[2:]
    if len(args) not in (1, 2):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    app_dir = Path(args[0]).resolve()
    ion_dir = Path(args[1]).resolve() if len(args) == 2 else None
    build = app_dir / ".vite" / "build"
    if not build.is_dir():
        print(f"[ERROR] no .vite/build under {app_dir}", file=sys.stderr)
        sys.exit(2)
    if any(ap.stale_input_marker(f.read_bytes()) for f in build.glob("index*.js")):
        print(
            f"[ERROR] {app_dir} already contains our injections; the probe "
            + "needs a PRISTINE extract (asar extract the official .deb again).",
            file=sys.stderr,
        )
        sys.exit(2)

    rows = []  # (verdict, name, detail, idempotent: bool | None)
    by_target = {}
    for pf in ap.discover_patch_files(patches_dir):
        spec, ptype = ap.parse_headers(pf)
        if not spec or not ptype:
            continue  # the orchestrator skips header-less files too
        binp = pf.with_suffix("")
        if not binp.is_file() or not os.access(binp, os.X_OK):
            print(f"[ERROR] {binp} not compiled (cd patches && make)", file=sys.stderr)
            sys.exit(2)
        if ptype == "nim-dir":
            if ion_dir is None or not ion_dir.is_dir():
                rows.append(("NOT-PROBED", pf.name, ["pass the ion-dist dir"], None))
                continue
            with tempfile.TemporaryDirectory() as td:
                work = Path(td) / "ion-dist"
                shutil.copytree(ion_dir, work)
                before = dir_digest(work)
                rc, already = run(binp, work)
                after = dir_digest(work)
                idem = None
                if rc == 0 and after != before:
                    rc2, _ = run(binp, work)
                    idem = rc2 == 0 and dir_digest(work) == after
            rows.append((rc, pf.name, (after != before, already), idem))
            continue
        # @patch-target paths start at "app.asar.contents/", like the orchestrator's
        real = ap.resolve_target(app_dir.parent, spec)
        if real is None or not real.is_file():
            rows.append(("FAILED", pf.name, [f"target not found: {spec}"], None))
            continue
        by_target.setdefault(real, []).append((pf.name, binp))

    for target, patches in by_target.items():
        parts = ap.chunk_parts(target)
        with tempfile.TemporaryDirectory() as td:
            staged = Path(td) / ("staged" + target.suffix)
            again = Path(td) / ("again" + target.suffix)
            staged.write_bytes(ap.concat_parts(parts) if parts else target.read_bytes())
            for name, binp in patches:
                before = sha(staged)
                rc, already = run(binp, staged)
                after = sha(staged)
                idem = None
                if rc == 0 and after != before:
                    shutil.copyfile(staged, again)
                    rc2, _ = run(binp, again)
                    idem = rc2 == 0 and sha(again) == after
                rows.append((rc, name, (after != before, already), idem))

    exceptions = IDEMPOTENCY_EXCEPTIONS
    today = datetime.date.today().isoformat()
    report, blocking = [], 0
    for verdict, name, detail, idem in rows:
        if isinstance(verdict, int):
            changed, already = detail
            if verdict != 0:
                verdict, detail = "FAILED", [f"exit {verdict} (apply_patches.py reports why)"]
            elif not changed:
                verdict, detail = "ABSORBED", already or ["zero bytes changed"]
            elif already:
                verdict, detail = "PARTIAL", already
            else:
                verdict, detail = "ACTIVE", []
        if verdict in ("ABSORBED", "PARTIAL"):
            blocking += 1
        stem = Path(name).stem
        exc = exceptions.get(stem)
        if idem is False:
            if exc is None:
                blocking += 1
                detail = detail + ["P2: second run on own output fails or changes bytes"]
            elif exc[1] < today:
                blocking += 1
                detail = detail + [f"P2: exception {exc[0]} expired {exc[1]}"]
            else:
                detail = detail + [f"P2: not idempotent (exception {exc[0]}, expires {exc[1]})"]
        elif idem is True and exc is not None:
            blocking += 1
            detail = detail + [f"P2: now idempotent - delete exception {exc[0]}"]
        report.append((verdict, name, detail))

    order = {"ABSORBED": 0, "PARTIAL": 1, "FAILED": 2, "NOT-PROBED": 3, "ACTIVE": 4}
    for verdict, name, detail in sorted(report, key=lambda x: (order[x[0]], x[1])):
        if verdict == "ACTIVE" and not detail:
            continue
        print(f"{verdict:<10} {name}")
        for d in detail:
            print(f"           {d[:140]}")
    counts = {v: sum(1 for r in report if r[0] == v) for v in order}
    print(
        "[absorbed-probe] "
        + ", ".join(f"{v}={n}" for v, n in counts.items() if n)
        + f"; blocking={blocking}"
    )
    if blocking:
        print(
            "[absorbed-probe] FAIL: a patch that changes nothing is a removal "
            + "candidate. Audit it against the new bundle (did upstream ship the "
            + "SAME behavior on Linux, or only something that looks like it?), then "
            + "git rm + bump EXPECTED_PATCH_COUNT. See AGENTS.md Rule 4.",
            file=sys.stderr,
        )
    sys.exit(1 if blocking else 0)


if __name__ == "__main__":
    main()
