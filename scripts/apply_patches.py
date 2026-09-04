#!/usr/bin/env python3
"""
Apply all patches in patches/ to the extracted app directory.

Discovers every file in the patches/ category subdirectories (linux/, core/,
community/) with @patch-target and @patch-type headers. For Nim patches
(@patch-type: nim), runs the compiled binary (same stem name, no extension,
sitting next to the source). For replace patches, copies the file to the
target location.

Target files are staged on tmpfs so each patch reads/writes the staged copy,
and only one real disk write happens per target at the end.

Usage: apply_patches.py <patches_dir> <app_dir>

<app_dir> is the directory that contains app.asar.contents/, i.e. the same
path that build-patched-tarball.sh uses as "$WORK_DIR/app".
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HEADER_RE = re.compile(r"@patch-(target|type):\s*(\S+)")

# Patch sources live in category subdirectories, not flat in patches/.
PATCH_SUBDIRS = ("linux", "core", "community")

# Every patch source must be accounted for. If a bad glob, a stray file or a
# forgotten `git mv` changes what gets discovered, the build must fail rather
# than quietly ship a release with a patch missing. Bump this when you add or
# remove a patch.
EXPECTED_PATCH_COUNT = 47


def discover_patch_files(patches_dir: Path):
    """Every file under the category subdirs, sorted by BASENAME.

    Sorting by basename (not by full path) keeps the application order
    identical to the old flat `sorted(patches_dir.iterdir())` layout. That
    order is load-bearing: 8 patches prepend to the staged bundle head, and
    later patches' regexes match against text earlier ones injected. Sorting
    by path instead would group by category and silently reorder them.
    """
    files = []
    for sub in PATCH_SUBDIRS:
        d = patches_dir / sub
        if not d.is_dir():
            print(
                f"[ERROR] Missing patch category directory: {d}",
                file=sys.stderr,
            )
            sys.exit(1)
        files.extend(p for p in d.iterdir() if p.is_file())
    return sorted(files, key=lambda p: p.name)


def parse_headers(path: Path):
    try:
        text = path.read_text(errors="ignore")
    except Exception:
        return None, None
    target = ptype = None
    for m in HEADER_RE.finditer(text):
        key, value = m.group(1), m.group(2)
        if key == "target" and target is None:
            target = value
        elif key == "type" and ptype is None:
            ptype = value
        if target and ptype:
            break
    return target, ptype


def resolve_target(app_dir: Path, target_spec: str):
    rel = Path(target_spec)
    if "*" in target_spec:
        base = app_dir / rel.parent
        matches = sorted(base.glob(rel.name))
        return matches[0] if matches else None
    return app_dir / rel


# --- Code-split chunk support -------------------------------------------------
# Since Claude Desktop v1.19367.0 the main bundle is code-split: .vite/build/
# index.js is a tiny loader stub and the real code lives in content-hashed
# sibling chunks (index.chunk-<hash>.js). Chunk names change every release, so
# patches keep targeting index.js and the orchestrator transparently stages the
# stub + all sibling chunks as ONE concatenated file (newline-separated boundary
# markers between parts). Patch binaries see the whole logical bundle, so their
# strict aggregate match counts keep working exactly as on the old monolith.
# After the group succeeds, the staged file is split back on the markers and
# each part is written to its original file.
#
# Safety: markers are comment lines a patch regex cannot plausibly produce or
# match across ('.' does not match newline in the patch regexes). If a patch
# replacement ever swallowed a marker, the part count check below fails the
# build loudly.

MARKER_PREFIX = "/*__CDB_SPLIT__"
MARKER_RE = re.compile(rb"\n/\*__CDB_SPLIT__([^*\n]+?)__\*/\n")


def chunk_parts(target_path: Path) -> list[Path] | None:
    """Return [target, chunk1, chunk2, ...] if code-split siblings exist, else None.

    Some releases (v1.26832.0 to v1.40609.0) emit a second chunk family for
    the same logical bundle (index2.chunk-<hash>.js, required from index.js
    and from index.chunk-* siblings); others (v1.46388.2) ship only
    index.chunk-*. The glob accepts an optional suffix after the stem
    (index*.chunk-*) so both layouts are staged the same way.
    """
    chunks = sorted(target_path.parent.glob(f"{target_path.stem}*.chunk-*{target_path.suffix}"))
    return [target_path] + chunks if chunks else None


def marker_for(name: str) -> bytes:
    return f"\n{MARKER_PREFIX}{name}__*/\n".encode()


def concat_parts(parts: list[Path]) -> bytes:
    blob = parts[0].read_bytes()
    for p in parts[1:]:
        blob += marker_for(p.name) + p.read_bytes()
    return blob


def check_cross_part_identifiers(contents: list[bytes], names: list[str]) -> bool:
    """Fail loud if an injected __cdb identifier is referenced across parts
    without a globalThis-backed definition.

    Each part is a separate CommonJS module at runtime, so a module-scoped
    `var __cdb_foo` in one part is invisible to every other part and throws
    ReferenceError there (the fix_asar_workspace_cwd/#191 failure class).
    Rule: any __cdb-prefixed bare identifier that appears in MORE than one
    part must be assigned via `globalThis.<name>=` somewhere in the bundle.
    Consequence for patch authors: never reuse a non-global __cdb name
    (e.g. a callback parameter) across two different injection sites.
    """
    global_names = set()
    for content in contents:
        global_names.update(
            m.decode()
            for m in re.findall(rb"globalThis\.(__cdb[\w$]*)\s*=", content)
        )
    parts_by_ident: dict[str, list[str]] = {}
    for name, content in zip(names, contents):
        # Bare references only: exclude property accesses (.__cdb...) and
        # longer identifiers that merely contain the prefix.
        for m in set(re.findall(rb"(?<![.\w$])(__cdb[\w$]*)", content)):
            parts_by_ident.setdefault(m.decode(), []).append(name)
    ok = True
    for ident, in_parts in sorted(parts_by_ident.items()):
        if len(in_parts) > 1 and ident not in global_names:
            print(
                f"  [FAIL] injected identifier '{ident}' is referenced in "
                f"multiple chunk parts ({', '.join(in_parts)}) but is not "
                f"defined on globalThis — it will throw ReferenceError at "
                f"runtime in every part that does not define it. Define it "
                f"via 'globalThis.{ident}=...' in the patch.",
                file=sys.stderr,
            )
            ok = False
    return ok


def split_and_write(blob: bytes, parts: list[Path]) -> bool:
    """Split staged blob on markers and write each part back. False on mismatch."""
    pieces = MARKER_RE.split(blob)
    # re.split with one capture group yields [content0, name1, content1, ...]
    contents = pieces[0::2]
    names = [n.decode() for n in pieces[1::2]]
    expected = [p.name for p in parts[1:]]
    if len(contents) != len(parts) or names != expected:
        print(
            f"  [FAIL] chunk boundary markers corrupted after patching: "
            f"expected {len(parts)} parts {expected}, got {len(contents)} parts {names}",
            file=sys.stderr,
        )
        return False
    if not check_cross_part_identifiers(contents, [parts[0].name] + names):
        return False
    for part_path, content in zip(parts, contents):
        part_path.write_bytes(content)
    return True


def run_nim_patch(nim_bin: Path, target_file: Path) -> bool:
    """Run a compiled Nim patch binary."""
    try:
        subprocess.run([str(nim_bin), str(target_file)], check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(
            f"  [FAIL] {nim_bin.name} exited with code {e.returncode}",
            file=sys.stderr,
        )
        return False


def main():
    if len(sys.argv) != 3:
        print("Usage: apply_patches.py <patches_dir> <app_dir>", file=sys.stderr)
        sys.exit(1)
    patches_dir = Path(sys.argv[1]).resolve()
    app_dir = Path(sys.argv[2]).resolve()

    if not patches_dir.is_dir():
        print(f"[ERROR] patches_dir not found: {patches_dir}", file=sys.stderr)
        sys.exit(1)
    if not app_dir.is_dir():
        print(f"[ERROR] app_dir not found: {app_dir}", file=sys.stderr)
        sys.exit(1)

    stray = sorted(p.name for p in patches_dir.glob("*.nim"))
    if stray:
        print(
            f"[ERROR] Patch source(s) sitting flat in {patches_dir} instead of a "
            f"category subdir ({', '.join(PATCH_SUBDIRS)}): {', '.join(stray)}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Parse headers first and assert the count BEFORE resolving any target, so
    # "a patch went missing" is reported as such instead of surfacing as the
    # first per-patch error further down.
    sources = []  # list[(patch_file, target_spec, ptype)]
    skipped = []
    for patch_file in discover_patch_files(patches_dir):
        target_spec, ptype = parse_headers(patch_file)
        if not target_spec or not ptype:
            skipped.append(patch_file.name)
            continue
        sources.append((patch_file, target_spec, ptype))

    if skipped:
        print(
            f"  Skipping {len(skipped)} file(s) without patch headers: "
            f"{', '.join(skipped)}"
        )

    if len(sources) != EXPECTED_PATCH_COUNT:
        print(
            f"\n[ERROR] Discovered {len(sources)} patch source(s), expected "
            f"{EXPECTED_PATCH_COUNT}.\n"
            f"        Searched: "
            f"{', '.join(str(patches_dir / s) for s in PATCH_SUBDIRS)}\n"
            "        If you added or removed a patch, update "
            "EXPECTED_PATCH_COUNT in this script.\n"
            "        Otherwise a patch went missing - do NOT ship this build.",
            file=sys.stderr,
        )
        sys.exit(1)

    replace_jobs = []  # list[(patch_file, real_target)]
    nim_jobs_by_target = {}  # real_target -> list[(patch_file, nim_binary)]

    for patch_file, target_spec, ptype in sources:
        if ptype == "replace":
            replace_jobs.append((patch_file, app_dir / target_spec))
        elif ptype == "nim":
            # Look for compiled binary: same directory as the source (i.e. the
            # category subdir), same stem, no extension
            nim_bin = patch_file.with_suffix("")
            if not nim_bin.is_file() or not os.access(nim_bin, os.X_OK):
                print(
                    f"[ERROR] Compiled binary not found for {patch_file.name}: "
                    f"expected {nim_bin}",
                    file=sys.stderr,
                )
                sys.exit(1)

            real = resolve_target(app_dir, target_spec)
            if real is None or not real.is_file():
                print(
                    f"[ERROR] Target not found for {patch_file.name}: {target_spec}",
                    file=sys.stderr,
                )
                sys.exit(1)
            nim_jobs_by_target.setdefault(real, []).append(
                (patch_file, nim_bin)
            )
        elif ptype == "nim-dir":
            # Handled separately by build script (e.g., ion-dist patches)
            pass
        elif ptype == "python":
            # Legacy fallback — shouldn't happen after migration
            print(
                f"  [WARN] Python patch found: {patch_file.name} — "
                "expected nim patches only",
                file=sys.stderr,
            )
        else:
            print(f"  [WARN] Unknown @patch-type '{ptype}' for {patch_file.name}")

    failed = False

    # Apply replace patches (just copy the file)
    for patch_file, target_path in replace_jobs:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(patch_file, target_path)
        print(
            f"  Applied replace: {patch_file.name} -> "
            f"{target_path.relative_to(app_dir)}"
        )

    # Apply Nim patches, grouped by target file
    # Stage each target on tmpfs for speed
    staging_root = None  # Could use /dev/shm if available
    for target_path, patches in nim_jobs_by_target.items():
        rel = target_path.relative_to(app_dir)
        parts = chunk_parts(target_path)
        chunk_note = f" +{len(parts) - 1} chunks" if parts else ""
        print(
            f"\n=== Patching {rel}{chunk_note} "
            f"({len(patches)} patch{'es' if len(patches) != 1 else ''}) ==="
        )

        with tempfile.NamedTemporaryFile(
            prefix="apply_patches_",
            suffix=target_path.suffix,
            dir=staging_root,
            delete=False,
        ) as tmp:
            staged = Path(tmp.name)
            tmp.write(concat_parts(parts) if parts else target_path.read_bytes())

        try:
            group_failed = False
            for patch_file, nim_bin in patches:
                if not run_nim_patch(nim_bin, staged):
                    group_failed = True
                    failed = True

            if not group_failed:
                if parts:
                    if not split_and_write(staged.read_bytes(), parts):
                        failed = True
                        print(f"  [SKIP-WRITE] {rel} chunk split failed")
                else:
                    shutil.copy(staged, target_path)
            else:
                print(f"  [SKIP-WRITE] {rel} not updated due to patch failure")
        finally:
            try:
                staged.unlink()
            except FileNotFoundError:
                pass

    if failed:
        print("\n[ERROR] One or more patches failed", file=sys.stderr)
        sys.exit(1)

    print("\nAll patches applied successfully.")


if __name__ == "__main__":
    main()
