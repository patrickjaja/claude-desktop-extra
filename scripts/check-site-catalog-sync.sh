#!/usr/bin/env bash
# Guard: the patch catalogue on the landing page (site/index.html, between the
# patch-catalog:start / patch-catalog:end markers) must equal what
# scripts/gen-site-patch-catalog.py renders from docs/patches.md.
#
# WHY: docs/patches.md is the catalogue we maintain, one table per patches/
# subdirectory. The landing page lets visitors browse and search every patch
# before installing, so it must show exactly those rows, never a hand-copied
# list that drifts after a patch is added, removed or reworded. The generator
# also fails when a table and patches/<dir>/*.nim disagree, so the page cannot
# advertise a patch that does not exist or miss one that ships.
#
# Regenerate after editing docs/patches.md:
#   bash scripts/check-site-catalog-sync.sh --write
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$SCRIPT_DIR/gen-site-patch-catalog.py"
MODE="${1:-check}"
if [ "$#" -gt 1 ]; then
  echo "usage: bash scripts/check-site-catalog-sync.sh [--check | --write]" >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[site-catalog] python3 not available - skipping (non-fatal)"
  exit 0
fi

case "$MODE" in
  --write) exec python3 -I "$GEN" --write ;;
  check|--check) exec python3 -I "$GEN" --check ;;
  *)
    echo "usage: bash scripts/check-site-catalog-sync.sh [--check | --write]" >&2
    exit 2
    ;;
esac
