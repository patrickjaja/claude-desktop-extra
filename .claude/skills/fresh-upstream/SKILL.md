---
name: fresh-upstream
description: For claude-desktop-extra - wipe any existing extracted Claude Desktop bundles and extract a fresh, CLEAN, UNPATCHED copy of the latest official Claude Desktop Linux .deb into ./tmp/ for patch analysis. Fetches + GPG/SHA256-verifies the latest .deb if missing or stale, then extracts app.asar via asar (NOT the build script, which applies patches).
disable-model-invocation: true
allowed-tools: Bash(rm -rf *), Bash(mkdir -p *), Bash(ar *), Bash(tar *), Bash(dpkg-deb *), Bash(asar *), Bash(node --check *), Bash(ls *), Bash(cat *), Bash(stat *), Bash(.github/scripts/apt-fetch-verify.sh *), Bash(sha256sum *)
---

# Fresh upstream extract (clean, unpatched)

Goal: a pristine unpatched bundle in `./tmp/` so patch work compares against the true upstream. Run from the repo root. `./tmp/` is gitignored.

**Critical:** `scripts/build-patched-tarball.sh` runs `apply_patches.py` - its output is PATCHED. For a clean baseline use the manual fetch + `asar` flow below.

## Steps

1. **cd to the repo** and read tracked version:
   ```bash
   cd "$(git rev-parse --show-toplevel)"
   cat .upstream-version
   ```

2. **Resolve latest upstream** version (GPG + SHA256-verified via the canonical fetcher):
   ```bash
   LATEST_VERSION=$(.github/scripts/apt-fetch-verify.sh poll)
   echo "upstream latest: $LATEST_VERSION"
   ```
   Report latest vs `.upstream-version` so the user sees whether this is a new version.

3. **Download + verify the official .deb if missing or stale.** `apt-fetch-verify.sh download`
   resolves the highest amd64 version, downloads the `.deb` into `./tmp/`, and verifies its SHA256
   against the signed Packages index (which is itself verified against the GPG-signed Release):
   ```bash
   mkdir -p ./tmp
   DEB=$(.github/scripts/apt-fetch-verify.sh download amd64 ./tmp)
   echo "verified .deb: $DEB"
   ```
   (~150MB.) If the download or verification fails, stop and report - do NOT trust an unverified `.deb`.

4. **Wipe old extracted bundles** (project-local only - never touch ~/.config/Claude):
   ```bash
   rm -rf ./tmp/extract ./tmp/app.asar.contents ./extract ./build/work 2>/dev/null || true
   ```
   Leave the freshly downloaded `./tmp/claude-desktop_*_amd64.deb` in place and leave `./build/`
   packages alone unless the user asked for a full clean.

5. **Extract clean, unpatched** to `./tmp/`. Crack the `.deb` (`dpkg-deb -x`, or `ar` + `tar` if
   `dpkg-deb` is unavailable), then `asar extract` the app.asar:
   ```bash
   dpkg-deb -x "$DEB" ./tmp/extract
   asar extract ./tmp/extract/usr/lib/claude-desktop/resources/app.asar ./tmp/app.asar.contents
   ```
   - Unpatched main bundle: `./tmp/app.asar.contents/.vite/build/index.js`
   - Renderer bundles: `./tmp/app.asar.contents/.vite/renderer/*/assets/*.js`
   - ion-dist (3P-config SPA): packed as `./tmp/extract/usr/lib/claude-desktop/resources/ion-dist.asar` since v4.29.0 (a plain `ion-dist/` dir before); read it with `asar extract ./tmp/extract/usr/lib/claude-desktop/resources/ion-dist.asar ./tmp/ion-dist`
   - i18n: `./tmp/app.asar.contents/resources/i18n/*.json` (inside app.asar since v4.29.0)

6. **Sanity check** and report:
   ```bash
   node --check ./tmp/app.asar.contents/.vite/build/index.js && echo "OK: clean unpatched index.js parses"
   ls -la ./tmp/app.asar.contents/.vite/build/
   ```
   Report: upstream version extracted, where the unpatched index.js is, whether it's a new version vs `.upstream-version`. If new, suggest `/update`. If just refreshing for analysis, suggest `/audit`.

## Notes
- This does NOT patch, build, or bump anything - it only stages a clean bundle.
- Distinguish "clean unpatched" (this skill, manual .deb crack + asar) from "patched build" (`./scripts/build-local.sh`).
- The official `.deb` bundles its own Electron (see `usr/lib/claude-desktop/version` in the deb tree) and prebuilt node-pty for both arches - we do not self-manage either.
- Stale extracts have different minified names → always re-extract before patch debugging if `./tmp` is older than today.
