#!/usr/bin/env bash
# Run every feature test harness under scripts/tests/{community,core}/.
#
# WHY THIS EXISTS
# ---------------
# The harnesses exercise what a clean patch run cannot prove: that the injected
# theme engine, the picker page, the panel tabs bar, the Extra settings area and
# the Deployment panel actually BEHAVE. They used to be manual tools nobody ran,
# so a regression only surfaced after a release. This runner is what CI executes.
#
# Each harness follows the repo's exit-code convention:
#   0 = PASS, 3 = SKIP (a tool the harness needs is not installed), other = FAIL.
# SKIP is not a failure: the DOM suites need a headless Chromium and the
# main-process suites need the compiled Nim patch binaries, and neither is
# available on every machine. A FAIL always fails the run.
#
# Usage:
#   scripts/run-feature-tests.sh              # every category (count is enforced)
#   scripts/run-feature-tests.sh community    # one category only
#   scripts/run-feature-tests.sh core
#   scripts/run-feature-tests.sh linux

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$SCRIPT_DIR/tests"

# Every harness must be accounted for. If a bad glob, a stray file or a forgotten
# `git mv` changes what gets discovered, this fails rather than quietly reporting
# a green run over a shrunken suite - the same reasoning as EXPECTED_PATCH_COUNT
# in scripts/apply_patches.py. Bump this when you add or remove a harness.
EXPECTED_TEST_HARNESSES=16

CATEGORIES=(community core linux)

usage() {
    echo "Usage: $(basename "$0") [community|core|linux]" >&2
    exit 2
}

case "${1-}" in
    "")            ENFORCE_COUNT=true ;;
    community|core|linux) CATEGORIES=("$1"); ENFORCE_COUNT=false ;;
    -h|--help)     usage ;;
    *)             echo "[ERROR] Unknown category: $1" >&2; usage ;;
esac

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] node is required to run the feature test harnesses" >&2
    exit 1
fi

# ---------------------------------------------------------------- discovery
SUITES=()
for cat in "${CATEGORIES[@]}"; do
    dir="$TESTS_DIR/$cat"
    if [ ! -d "$dir" ]; then
        echo "[ERROR] Missing test category directory: $dir" >&2
        exit 1
    fi
    found=()
    while IFS= read -r f; do
        found+=("$f")
    done < <(find "$dir" -maxdepth 1 -name '*.mjs' -type f | sort)
    if [ ${#found[@]} -eq 0 ]; then
        echo "[ERROR] No test harnesses found in $dir" >&2
        echo "        A category directory must never be empty - if the tests" >&2
        echo "        moved, fix this runner; do NOT ship a build validated by" >&2
        echo "        an empty suite." >&2
        exit 1
    fi
    SUITES+=("${found[@]}")
done

if [ "$ENFORCE_COUNT" = true ] && [ ${#SUITES[@]} -ne "$EXPECTED_TEST_HARNESSES" ]; then
    echo "[ERROR] Discovered ${#SUITES[@]} test harness(es), expected $EXPECTED_TEST_HARNESSES." >&2
    echo "        Searched: ${TESTS_DIR}/{$(IFS=,; echo "${CATEGORIES[*]}")}/*.mjs" >&2
    echo "        If you added or removed a harness, update" >&2
    echo "        EXPECTED_TEST_HARNESSES in this script." >&2
    echo "        Otherwise a harness went missing - do NOT ship this build." >&2
    exit 1
fi

# ---------------------------------------------------------------- run
echo "==================================================="
echo "Feature test harnesses (${#SUITES[@]} suite(s): ${CATEGORIES[*]})"
echo "==================================================="

PASSED=0
FAILED=0
SKIPPED=0
FAILED_NAMES=()

for suite in "${SUITES[@]}"; do
    rel="${suite#"$SCRIPT_DIR"/}"
    echo ""
    echo "--- $rel"
    # Hard per-harness wall clock. A harness that wedges (the DOM suites drive a
    # headless browser, which can hang in an environment the author never saw)
    # must fail THIS suite, not stall the whole job: without this a single stuck
    # harness burned a 6h GitHub workflow timeout instead of reporting a failure.
    # Generous on purpose - the slowest suite here runs well under a minute.
    out=$(timeout --kill-after=30s "${FEATURE_TEST_TIMEOUT:-600}" node "$suite" 2>&1) && rc=0 || rc=$?
    echo "$out" | sed 's/^/    /'
    case $rc in
        0)
            echo "  PASS  $rel"
            PASSED=$((PASSED + 1))
            ;;
        3)
            echo "  SKIP  $rel (the harness reported a missing tool)"
            SKIPPED=$((SKIPPED + 1))
            ;;
        124|137)
            echo "  FAIL  $rel (timed out after ${FEATURE_TEST_TIMEOUT:-600}s and was killed)"
            FAILED=$((FAILED + 1))
            FAILED_NAMES+=("$rel (timeout)")
            ;;
        *)
            echo "  FAIL  $rel (exit $rc)"
            FAILED=$((FAILED + 1))
            FAILED_NAMES+=("$rel")
            ;;
    esac
done

echo ""
echo "==================================================="
echo "Summary: $PASSED passed, $FAILED failed, $SKIPPED skipped (of ${#SUITES[@]})"
echo "==================================================="

if [ "$FAILED" -gt 0 ]; then
    for name in "${FAILED_NAMES[@]}"; do
        echo "::error::feature test harness failed: $name"
    done
    exit 1
fi

exit 0
