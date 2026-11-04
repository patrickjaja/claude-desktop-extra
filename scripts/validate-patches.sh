#!/bin/bash
#
# Validate all patches against an extracted app.asar.contents directory
#
# This script runs each patch on a staged copy of its target WITHOUT modifying
# the extract, allowing you to verify patches will work before running a full
# build.
#
# Patches are applied CUMULATIVELY per target, in the orchestrator's order:
# like scripts/apply_patches.py, every file under patches/{linux,core,community}/
# that carries both an @patch-target and an @patch-type header, sorted by
# BASENAME across the category dirs. Running each patch alone on a pristine
# copy is not enough, because a patch may depend on an earlier patch's end state
# on the same target (add_feature_transcript_limits asserts the worker-host fork
# that add_feature_files_quick_open sub-patch B injects); validated in
# isolation it would FAIL here while the real build passes.
#
# Each resolved target keeps ONE staged state: the stub + chunks concatenation
# for a code-split bundle (staged as apply_patches.py stages it), a copy of the
# directory for nim-dir patches. Each patch runs on a copy of that state; on
# PASS the copy becomes the new state, on FAIL the state is left as it was.
# Unlike the orchestrator, which stops at the first failure, every patch still
# runs and every failure is listed. A patch after a FAIL on the same target sees
# the last good state, so one failure can cascade into the patches that build on
# it: fix the first FAIL per target first.
#
# Usage:
#   ./scripts/validate-patches.sh <app.asar.contents_path> [path_to_deb_tree]
#   ./scripts/validate-patches.sh                         # Uses current dir
#
# Example workflow:
#   1. Download and extract Claude Desktop
#   2. Extract app.asar: asar extract app.asar app.asar.contents
#   3. Run: ./scripts/validate-patches.sh ./app.asar.contents
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PATCHES_DIR="$PROJECT_DIR/patches"
# Same list, same order as PATCH_SUBDIRS in apply_patches.py.
PATCH_SUBDIRS=(linux core community)

APP_CONTENTS="${1:-.}"

# Check if the directory looks like an app.asar.contents
if [ ! -d "$APP_CONTENTS/.vite" ]; then
    echo "Error: Invalid app.asar.contents directory"
    echo "Expected to find .vite/ directory in: $APP_CONTENTS"
    echo ""
    echo "Usage: $0 <path_to_app.asar.contents> [path_to_deb_tree]"
    echo ""
    echo "Example:"
    echo "  asar extract app.asar app.asar.contents"
    echo "  $0 ./app.asar.contents"
    echo ""
    echo "nim-dir patches (ion-dist) target the .deb's resources tree, not"
    echo "app.asar. Pass the extracted tree (e.g. ./tmp/extract/usr/lib/claude-desktop)"
    echo "as the second argument; without it a sibling ../extract/usr/lib/claude-desktop"
    echo "of app.asar.contents is probed, and if neither exists those patches SKIP."
    echo "A packed resources/ion-dist.asar (v4.29.0+) is extracted to a temp dir."
    exit 1
fi

DEB_TREE="${2:-}"

for sub in "${PATCH_SUBDIRS[@]}"; do
    if [ ! -d "$PATCHES_DIR/$sub" ]; then
        echo "Error: Missing patch category directory: $PATCHES_DIR/$sub"
        exit 1
    fi
done

# Every staged copy and log lives here and is removed on any exit (the INT/TERM
# traps turn a signal into an exit so the EXIT trap runs). The chmod matters for
# directory copies of a read-only extract: cp -R reproduces the source's
# read-only modes, and rm -rf cannot empty a read-only directory.
WORK_DIR="$(mktemp -d)"
trap 'chmod -R u+w "$WORK_DIR" 2>/dev/null; rm -rf "$WORK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Compile Nim patches first (required for validation)
echo "Compiling Nim patches..."
"$SCRIPT_DIR/compile-nim-patches.sh"

# path_stem <path>: the path minus its last suffix, like pathlib's
# with_suffix("") (patch source -> compiled binary, index.js -> index).
path_stem() {
    local base="${1##*/}"
    if [[ "$base" == ?*.* ]]; then
        printf '%s\n' "${1%.*}"
    else
        printf '%s\n' "$1"
    fi
}

# header_value <file> <target|type>: the first @patch-<key>: value, read the way
# HEADER_RE in apply_patches.py reads it (first non-blank token). -a because the
# compiled patch binaries sit next to their sources and are scanned too.
header_value() {
    grep -a -m1 -o -E "@patch-$2:[[:space:]]*[^[:space:]]+" "$1" 2>/dev/null | head -n1 |
        sed -E "s/^@patch-$2:[[:space:]]*//"
}

# stage_file <target> <dest>: write the pristine staged form of a file target.
# Code-split bundles (v1.19367.0+): the stub + all content-hashed sibling chunks
# as ONE concatenation with boundary markers, chunks in codepoint order, exactly
# as chunk_parts()/concat_parts() in apply_patches.py build it, so patch match
# counts see the whole logical bundle. The <stem>*.chunk-* glob accepts an
# optional suffix after the stem to cover both chunk families (index.chunk-*,
# index2.chunk-*). Any other file is copied as is.
stage_file() {
    local stem base suffix=""
    stem="$(path_stem "$1")"
    base="${1##*/}"
    [ "$stem" = "$1" ] || suffix=".${base##*.}"
    {
        cat "$1"
        find "${1%/*}" -mindepth 1 -maxdepth 1 -name "${stem##*/}*.chunk-*$suffix" |
            LC_ALL=C sort |
            while IFS= read -r chunk; do
                printf '\n/*__CDB_SPLIT__%s__*/\n' "${chunk##*/}"
                cat "$chunk"
            done
    } >"$2"
}

# copy_dir <src> <dest>: copy a directory target, writable even when the
# source tree is read-only (the patch writes into the copy).
copy_dir() {
    mkdir -p "$2"
    cp -R "$1"/. "$2"/
    chmod -R u+w "$2"
}

# Every regular file in the category dirs, sorted by basename in codepoint
# order with ties kept in discovery order: discover_patch_files() in
# apply_patches.py. That order is load-bearing (see the header comment).
mapfile -t PATCH_FILES < <(
    for sub in "${PATCH_SUBDIRS[@]}"; do
        find -L "$PATCHES_DIR/$sub" -mindepth 1 -maxdepth 1 -type f -printf '%f\t%p\n'
    done | LC_ALL=C sort -s -t $'\t' -k1,1 | cut -f2-
)

echo "==================================="
echo "  Patch Validation Report"
echo "==================================="
echo "App contents: $APP_CONTENTS"
echo "Order: apply_patches.py (basename order, cumulative per target)"
echo ""

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0

# Per resolved target: the path of its current staged state (unset until the
# first patch on it passes; until then the pristine target is the input), and
# how many patches on it passed / failed so far.
declare -A STAGED=()
declare -A STAGED_PASS=()
declare -A STAGED_FAIL=()
# packed nim-dir target (<deb tree>/<target>.asar) -> its one extract in $WORK_DIR
declare -A ASAR_EXTRACT=()
SEQ=0

for patch_file in "${PATCH_FILES[@]}"; do
    filename=$(basename "$patch_file")
    # Compiled binary sits next to its source, same stem, no extension.
    nim_bin="$(path_stem "$patch_file")"

    # Extract metadata
    target=$(header_value "$patch_file" target)
    patch_type=$(header_value "$patch_file" type)

    if [ -z "$target" ] || [ -z "$patch_type" ]; then
        # A patch's compiled binary is not a patch: nothing to report.
        [ -f "$patch_file.nim" ] && continue
        TOTAL=$((TOTAL + 1))
        echo "[$filename]"
        echo "  Status: SKIP (no @patch-target/@patch-type metadata; apply_patches.py skips it too)"
        SKIPPED=$((SKIPPED + 1))
        echo ""
        continue
    fi

    TOTAL=$((TOTAL + 1))
    echo "[$filename]"
    echo "  Target: $target"
    echo "  Type: $patch_type"

    # Resolve the target path (handle glob patterns in the last component; the
    # first match in codepoint order wins, like resolve_target())
    if [[ "$target" == *"*"* ]]; then
        dir_part=$(dirname "$target")
        file_pattern=$(basename "$target")
        search_dir="$APP_CONTENTS/${dir_part#app.asar.contents/}"
        actual_target=$(find "$search_dir" -mindepth 1 -maxdepth 1 -name "$file_pattern" 2>/dev/null | LC_ALL=C sort | head -1)
    else
        actual_target="$APP_CONTENTS/${target#app.asar.contents/}"
    fi

    # For replace patches, target doesn't need to exist
    if [ "$patch_type" = "replace" ]; then
        echo "  Resolved: (will be created)"
        echo "  Status: PASS (file replacement)"
        PASSED=$((PASSED + 1))
        echo ""
        continue
    fi

    if [ "$patch_type" = "nim-dir" ]; then
        # nim-dir targets live in the .deb's resources tree, NOT inside
        # app.asar - they can never resolve under $APP_CONTENTS. Probe the
        # explicit deb tree argument, then the conventional sibling layout
        # (tmp/app.asar.contents next to tmp/extract/), and only SKIP - not
        # FAIL - when neither is available: real builds exercise these
        # patches via build-patched-tarball.sh against the full tree.
        # Since v4.29.0 the .deb packs resources/ion-dist as ion-dist.asar:
        # a "<target>.asar" file is extracted once into $WORK_DIR and that
        # extract is the pristine directory every patch on the target stages
        # from (the shipped tree is never touched). The asar wins over a
        # same-named directory, like upstream's packaged path: since v4.16336.0
        # the .deb also ships resources/ion-dist/ holding only a static
        # placeholder index.html that the app never loads.
        if [ -z "$actual_target" ] || [ ! -d "$actual_target" ]; then
            sibling_tree="$(dirname "$APP_CONTENTS")/extract/usr/lib/claude-desktop"
            for tree in "$DEB_TREE" "$sibling_tree"; do
                [ -n "$tree" ] || continue
                if [ ! -f "$tree/$target.asar" ]; then
                    if [ -d "$tree/$target" ]; then
                        actual_target="$tree/$target"
                        break
                    fi
                    continue
                fi
                if [ -z "${ASAR_EXTRACT[$tree/$target.asar]:-}" ]; then
                    if ! command -v asar >/dev/null 2>&1; then
                        echo "  Status: FAIL (asar CLI not found; needed to extract $tree/$target.asar)"
                        FAILED=$((FAILED + 1))
                        echo ""
                        continue 2
                    fi
                    SEQ=$((SEQ + 1))
                    ASAR_EXTRACT[$tree/$target.asar]="$WORK_DIR/asar-$SEQ/${target##*/}"
                    if ! asar extract "$tree/$target.asar" "${ASAR_EXTRACT[$tree/$target.asar]}"; then
                        echo "  Status: FAIL (asar extract of $tree/$target.asar failed)"
                        FAILED=$((FAILED + 1))
                        echo ""
                        continue 2
                    fi
                fi
                actual_target="${ASAR_EXTRACT[$tree/$target.asar]}"
                echo "  Source: $tree/$target.asar (extracted)"
                break
            done
        fi
        if [ -z "$actual_target" ] || [ ! -d "$actual_target" ]; then
            echo "  Status: SKIP (target lives in the .deb tree, not app.asar;"
            echo "          pass the extracted tree as 2nd arg or extract the .deb"
            echo "          to a sibling ../extract/ - build-patched-tarball.sh"
            echo "          exercises this patch in real builds)"
            SKIPPED=$((SKIPPED + 1))
            echo ""
            continue
        fi
    elif [ -z "$actual_target" ] || [ ! -f "$actual_target" ]; then
        echo "  Status: FAIL (target file not found)"
        FAILED=$((FAILED + 1))
        echo ""
        continue
    fi

    echo "  Resolved: $actual_target"

    if [ "$patch_type" != "nim" ] && [ "$patch_type" != "nim-dir" ]; then
        echo "  Status: SKIP (unknown type: $patch_type)"
        SKIPPED=$((SKIPPED + 1))
        echo ""
        continue
    fi

    # nim patches take a file argument; nim-dir patches take a directory and
    # locate their content-hashed target file inside it (e.g. ion-dist SPA
    # bundles).
    if [ ! -x "$nim_bin" ]; then
        echo "  Status: FAIL (compiled binary not found: $nim_bin)"
        FAILED=$((FAILED + 1))
        echo ""
        continue
    fi

    state="${STAGED[$actual_target]:-}"
    n_pass="${STAGED_PASS[$actual_target]:-0}"
    n_fail="${STAGED_FAIL[$actual_target]:-0}"
    input="pristine target"
    [ "$n_pass" -gt 0 ] && input="staged state after $n_pass earlier passing patch(es) on this target"
    [ "$n_fail" -gt 0 ] && input="$input ($n_fail earlier FAIL(s) not applied)"
    echo "  Input: $input"

    # The patch runs on a COPY of the target's current state, so a failing
    # patch cannot leave a half-patched state behind for the next one.
    SEQ=$((SEQ + 1))
    if [ "$patch_type" = "nim" ]; then
        cand="$WORK_DIR/$SEQ-${actual_target##*/}"
        if [ -n "$state" ]; then
            cp "$state" "$cand"
        else
            stage_file "$actual_target" "$cand"
        fi
    else
        cand="$WORK_DIR/$SEQ/${actual_target##*/}"
        copy_dir "${state:-$actual_target}" "$cand"
    fi

    # `&& ... ||` keeps set -e from aborting the whole report on the first
    # failing patch.
    output=$("$nim_bin" "$cand" 2>&1) && result=0 || result=$?
    echo "$output" | sed 's/^/  /'
    if [ "$result" -eq 0 ]; then
        echo "  Status: PASS"
        PASSED=$((PASSED + 1))
        # The patched copy becomes the state the next patch on this target sees.
        [ -z "$state" ] || rm -rf "$state"
        STAGED[$actual_target]="$cand"
        STAGED_PASS[$actual_target]=$((n_pass + 1))
    else
        echo "  Status: FAIL"
        FAILED=$((FAILED + 1))
        # Later patches on this target run against the last good state.
        rm -rf "$cand"
        STAGED_FAIL[$actual_target]=$((n_fail + 1))
    fi

    echo ""
done

# A clean patch run says nothing about the features' LIVE behaviour: whether the
# theme engine re-themes every open window, whether the picker groups its
# sections, whether the panel tabs bar mounts into remote epitaxy DOM, whether
# the "Extra" settings area renders, or whether the Deployment panel writes the
# file the 1P/3P bootstrap reads. The feature test harnesses under
# scripts/tests/{community,core}/ cover exactly that, and scripts/run-feature-tests.sh
# is the single place that knows which ones exist (it also runs in CI) - so this
# script delegates rather than keeping a second, driftable copy of the list.
echo "-----------------------------------"
echo "Feature test harnesses (scripts/run-feature-tests.sh)"
if command -v node >/dev/null 2>&1; then
    TOTAL=$((TOTAL + 1))
    # The RUNNER's exit status decides, never the pipeline's: `runner | sed`
    # reports sed's status, which is always 0.
    FT_LOG="$WORK_DIR/feature-tests.log"
    if "$SCRIPT_DIR/run-feature-tests.sh" >"$FT_LOG" 2>&1; then
        FT_RC=0
    else
        FT_RC=$?
    fi
    sed 's/^/  /' "$FT_LOG"
    if [ "$FT_RC" -eq 0 ]; then
        echo "  Status: PASS"
        PASSED=$((PASSED + 1))
    else
        echo "  Status: FAIL"
        FAILED=$((FAILED + 1))
    fi
else
    echo "  Status: SKIP (no node on this machine)"
    TOTAL=$((TOTAL + 1))
    SKIPPED=$((SKIPPED + 1))
fi
echo ""

echo "==================================="
echo "  Summary"
echo "==================================="
echo "  Total:   $TOTAL"
echo "  Passed:  $PASSED"
echo "  Failed:  $FAILED"
echo "  Skipped: $SKIPPED"
echo "==================================="

if [ $FAILED -gt 0 ]; then
    echo ""
    echo "VALIDATION FAILED - $FAILED patch(es) did not match"
    echo "Please update the patches to match the new file structure."
    exit 1
fi

echo ""
echo "All patches validated successfully!"
exit 0
