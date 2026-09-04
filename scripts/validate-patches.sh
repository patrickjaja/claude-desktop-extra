#!/bin/bash
#
# Validate all patches against an extracted app.asar.contents directory
#
# This script tests each patch against target files WITHOUT modifying them,
# allowing you to verify patches will work before running a full build.
#
# Usage:
#   ./scripts/validate-patches.sh <app.asar.contents_path>
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
    exit 1
fi

DEB_TREE="${2:-}"

# Compile Nim patches first (required for validation)
echo "Compiling Nim patches..."
"$SCRIPT_DIR/compile-nim-patches.sh"

echo "==================================="
echo "  Patch Validation Report"
echo "==================================="
echo "App contents: $APP_CONTENTS"
echo ""

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0

# Patch sources live one level down, in the category subdirs (linux/, core/,
# community/). The */ glob picks up any category without needing edits here.
for patch_file in "$PATCHES_DIR"/*/*.nim "$PATCHES_DIR"/*/*.js; do
    [ -f "$patch_file" ] || continue

    TOTAL=$((TOTAL + 1))
    filename=$(basename "$patch_file")
    # Compiled binary sits next to its source, so derive it from the full path -
    # basename alone would drop the category subdir.
    nim_bin="${patch_file%.nim}"

    # Extract metadata
    target=$(grep -m1 '@patch-target:' "$patch_file" 2>/dev/null | sed 's/.*@patch-target:[[:space:]]*//' | tr -d '\r' || echo "")
    patch_type=$(grep -m1 '@patch-type:' "$patch_file" 2>/dev/null | sed 's/.*@patch-type:[[:space:]]*//' | tr -d '\r' || echo "")

    if [ -z "$target" ]; then
        echo "[$filename]"
        echo "  Status: SKIP (no @patch-target metadata)"
        SKIPPED=$((SKIPPED + 1))
        echo ""
        continue
    fi

    echo "[$filename]"
    echo "  Target: $target"
    echo "  Type: $patch_type"

    # Resolve the target path (handle glob patterns)
    if [[ "$target" == *"*"* ]]; then
        dir_part=$(dirname "$target")
        file_pattern=$(basename "$target")
        search_dir="$APP_CONTENTS/${dir_part#app.asar.contents/}"
        actual_target=$(find "$search_dir" -name "$file_pattern" 2>/dev/null | head -1)
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
        if [ -z "$actual_target" ] || [ ! -d "$actual_target" ]; then
            sibling_tree="$(dirname "$APP_CONTENTS")/extract/usr/lib/claude-desktop"
            for tree in "$DEB_TREE" "$sibling_tree"; do
                [ -n "$tree" ] && [ -d "$tree/$target" ] || continue
                actual_target="$tree/$target"
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

    # For Nim patches, run the compiled binary on a copy
    if [ "$patch_type" = "nim" ]; then
        if [ ! -x "$nim_bin" ]; then
            echo "  Status: FAIL (compiled binary not found: $nim_bin)"
            FAILED=$((FAILED + 1))
            echo ""
            continue
        fi

        tmp_file=$(mktemp)
        # Code-split bundles (v1.19367.0+): stage the stub + all content-hashed
        # sibling chunks as one concatenation, mirroring apply_patches.py, so
        # patch match counts see the whole logical bundle.
        target_dir=$(dirname "$actual_target")
        target_base=$(basename "$actual_target")
        target_stem="${target_base%.js}"
        # Some releases ship a second chunk family (index2.chunk-*.js) for the
        # same logical bundle, others only index.chunk-*; the glob accepts an
        # optional suffix after the stem to cover both - keep in sync with
        # chunk_parts() in apply_patches.py.
        if compgen -G "$target_dir/$target_stem*.chunk-*.js" > /dev/null; then
            cat "$actual_target" > "$tmp_file"
            for chunk in "$target_dir/$target_stem"*.chunk-*.js; do
                printf '\n/*__CDB_SPLIT__%s__*/\n' "$(basename "$chunk")" >> "$tmp_file"
                cat "$chunk" >> "$tmp_file"
            done
        else
            cp "$actual_target" "$tmp_file"
        fi

        # `&& ... ||` keeps set -e from aborting the whole report on the first
        # failing patch (mirrors the nim-dir branch below).
        output=$("$nim_bin" "$tmp_file" 2>&1) && result=0 || result=$?
        echo "$output" | sed 's/^/  /'
        if [ $result -eq 0 ]; then
            echo "  Status: PASS"
            PASSED=$((PASSED + 1))
        else
            echo "  Status: FAIL"
            FAILED=$((FAILED + 1))
        fi

        rm -f "$tmp_file"
    elif [ "$patch_type" = "nim-dir" ]; then
        # nim-dir patches take a directory argument and locate their
        # content-hashed target file inside it (e.g. ion-dist SPA bundles)
        if [ ! -x "$nim_bin" ]; then
            echo "  Status: FAIL (compiled binary not found: $nim_bin)"
            FAILED=$((FAILED + 1))
            echo ""
            continue
        fi

        tmp_dir=$(mktemp -d)
        cp -r "$actual_target"/. "$tmp_dir"/

        output=$("$nim_bin" "$tmp_dir" 2>&1) && result=0 || result=$?
        echo "$output" | sed 's/^/  /'
        if [ $result -eq 0 ]; then
            echo "  Status: PASS"
            PASSED=$((PASSED + 1))
        else
            echo "  Status: FAIL"
            FAILED=$((FAILED + 1))
        fi

        rm -rf "$tmp_dir"
    else
        echo "  Status: SKIP (unknown type: $patch_type)"
        SKIPPED=$((SKIPPED + 1))
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
    FT_LOG="$(mktemp)"
    if "$SCRIPT_DIR/run-feature-tests.sh" >"$FT_LOG" 2>&1; then
        FT_RC=0
    else
        FT_RC=$?
    fi
    sed 's/^/  /' "$FT_LOG"
    rm -f "$FT_LOG"
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
