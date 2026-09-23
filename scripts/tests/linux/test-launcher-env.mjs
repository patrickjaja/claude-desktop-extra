#!/usr/bin/env node
// Launcher environment handling: the cases a packaged install hits that a
// developer box running /usr/bin/claude-desktop never does.
//
// WHY THIS EXISTS
// ---------------
// scripts/claude-desktop-launcher.sh is the same file on every package, but
// each package reaches it differently:
//
//   - Nix runs it through a makeWrapper script, so `readlink -f "$0"` resolves
//     to the UNWRAPPED launcher in the store. An autostart entry or a named
//     profile pointing there starts without the wrapper's environment and exits
//     "Electron binary not found", and points into a path garbage collection
//     removes.
//   - The AppImage runs it from a FUSE mount whose path changes every launch,
//     with CLAUDE_ELECTRON pointing into that mount.
//   - Compositors differ in whether an XWayland server exists at all; $DISPLAY
//     is the only honest signal, not the compositor's name.
//   - A session started from a TTY can carry XDG_SESSION_TYPE=tty while
//     WAYLAND_DISPLAY is set.
//   - busctl can be installed yet unable to answer (no systemd user bus), which
//     must not end the kwallet probe.
//
// None of these show up on a green build. This harness extracts the real
// functions from the launcher (and the real AppRun from build-appimage.sh) and
// runs them against simulated environments, and drives the real launcher's
// --create-profile through a makeWrapper-style wrapper. It never starts
// Electron.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync,
         existsSync, readlinkSync, lstatSync, symlinkSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const launcherPath = join(repo, "scripts", "claude-desktop-launcher.sh");
const launcherSrc = readFileSync(launcherPath, "utf8");
const appimageBuilder = readFileSync(
  join(repo, "packaging", "appimage", "build-appimage.sh"), "utf8");

// Resolved once: several cases run with a PATH that holds only fake tools.
const BASH = (spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout || "").trim();
if (!BASH) {
  console.log("SKIP: bash not found");
  process.exit(3);
}

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${JSON.stringify(actual)}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failures.push(label);
  }
}

// Pull one top-level function definition out of the launcher, verbatim.
function fn(name) {
  const re = new RegExp(`^${name.replace(/[$]/g, "\\$")}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m");
  const m = launcherSrc.match(re);
  if (!m) throw new Error(`launcher function ${name}() not found`);
  return m[0];
}

const scratch = join(tmpdir(), `cdb-launcher-env-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

function writeExe(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Run a bash snippet with the named launcher functions defined, a log() stub
// that writes to stderr, and exactly the given environment.
function runFns(fnNames, script, env) {
  const prelude = [
    "set -euo pipefail",
    "APP_ID=claude",
    'log() { echo "LOG: $1" >&2; }',
    ...fnNames.map(fn),
  ].join("\n");
  const r = spawnSync(BASH, ["-c", `${prelude}\n${script}`], {
    env, encoding: "utf8",
  });
  return { out: (r.stdout || "").trim(), err: r.stderr || "", status: r.status };
}

function safe(label, f) {
  try { f(); } catch (e) {
    console.log(`  FAIL ${label} -> threw: ${e.message}`);
    failures.push(label);
  }
}

// A fake install tree: an executable Electron stand-in plus resources/app.asar.
function fakeTree(dir) {
  writeExe(join(dir, "claude"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(dir, "resources"), { recursive: true });
  writeFileSync(join(dir, "resources", "app.asar"), "asar");
  writeFileSync(join(dir, "libffmpeg.so"), "so");
  return join(dir, "claude");
}

const baseEnv = { PATH: "/usr/bin:/bin" };

// ---------------------------------------------------------------- N1
console.log("N1: launcher self-reference survives a makeWrapper wrapper");
safe("N1 resolve", () => {
  const bin = join(scratch, "n1", "bin");
  writeExe(join(bin, "claude-desktop"), "#!/bin/sh\nexit 0\n");
  const real = join(scratch, "n1", "real-launcher.sh");
  writeExe(real, "#!/bin/sh\n");
  const link = join(scratch, "n1", "link");
  symlinkSync(real, link);
  const f = ["_resolve_launcher_self"];
  check("pre-set bare CLAUDE_LAUNCHER is kept",
    runFns(f, `_resolve_launcher_self "${link}"`,
      { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_LAUNCHER: "claude-desktop" }).out,
    "claude-desktop");
  check("unset CLAUDE_LAUNCHER resolves $0",
    runFns(f, `_resolve_launcher_self "${link}"`, baseEnv).out, real);
  check("unrunnable CLAUDE_LAUNCHER falls back to $0",
    runFns(f, `_resolve_launcher_self "${link}"`,
      { ...baseEnv, CLAUDE_LAUNCHER: "/nonexistent/claude-desktop" }).out, real);
  check("AppImage path wins over an inherited CLAUDE_LAUNCHER",
    runFns(f, `_resolve_launcher_self "${link}"`,
      { ...baseEnv, CLAUDE_LAUNCHER: "claude-desktop",
        CLAUDE_APPIMAGE_PATH: "/home/u/Claude.AppImage" }).out,
    "/home/u/Claude.AppImage");
});

safe("N1 create-profile via wrapper", () => {
  // makeWrapper exec form: the wrapper sets env and execs the store copy of
  // the launcher by absolute path, so the launcher's $0 is that store path.
  const root = join(scratch, "n1w");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = join(root, "store");
  const electron = fakeTree(join(store, "lib", "claude-desktop"));
  const unwrapped = join(store, "lib", "claude-desktop", "launcher.sh");
  writeExe(unwrapped, launcherSrc);
  const wrapper = join(store, "bin", "claude-desktop");
  writeExe(wrapper, [
    "#! /bin/bash -e",
    `export CLAUDE_ELECTRON='${electron}'`,
    "export CLAUDE_LAUNCHER='claude-desktop'",
    `exec "${unwrapped}" "$@"`,
    "",
  ].join("\n"));
  const r = spawnSync(wrapper, ["--create-profile=work"], {
    env: { PATH: `${join(store, "bin")}:/usr/bin:/bin`, HOME: home,
           XDG_RUNTIME_DIR: join(root, "run") },
    encoding: "utf8",
  });
  check("create-profile exit status", r.status, 0);
  if (r.status !== 0) console.log(r.stdout + r.stderr);
  const desktop = join(home, ".local/share/applications/com.anthropic.Claude-work.desktop");
  const execLine = existsSync(desktop)
    ? readFileSync(desktop, "utf8").split("\n").find((l) => l.startsWith("Exec=")) : null;
  check("profile .desktop Exec uses the wrapper name", execLine,
    "Exec=claude-desktop --profile=work %u");
  const entry = join(home, ".local/bin/claude-desktop-work");
  let entryText = "";
  if (existsSync(entry)) {
    entryText = lstatSync(entry).isSymbolicLink()
      ? `symlink:${readlinkSync(entry)}` : readFileSync(entry, "utf8");
  }
  check("profile entry point does not bypass the wrapper",
    entryText.includes(unwrapped), false);
  check("profile entry point starts the wrapper with the profile",
    /exec .*claude-desktop['"]? --profile=work /.test(entryText), true);
});

// ---------------------------------------------------------------- L1
console.log("L1: per-profile refresh follows CLAUDE_ELECTRON");
safe("L1 canonical", () => {
  const root = join(scratch, "l1");
  const home = join(root, "home");
  const treeA = fakeTree(join(root, "treeA"));
  const f = ["_canonical_electron_bin"];
  check("CLAUDE_ELECTRON is the canonical binary",
    runFns(f, "_canonical_electron_bin", { ...baseEnv, HOME: home, CLAUDE_ELECTRON: treeA }).out,
    treeA);
  const profCopy = join(home, ".local/lib/claude-desktop/claude-work");
  writeExe(profCopy, "#!/bin/sh\n");
  const r = runFns(f, "_canonical_electron_bin || true",
    { ...baseEnv, HOME: home, CLAUDE_ELECTRON: profCopy });
  check("a per-profile copy is never canonical", r.out === profCopy, false);
});

safe("L1 refresh from a moved install", () => {
  const root = join(scratch, "l1r");
  const home = join(root, "home");
  const treeA = fakeTree(join(root, "treeA"));
  const treeB = fakeTree(join(root, "treeB"));
  // Nix store files carry mtime 1, so "canonical is newer" can never fire.
  utimesSync(treeB, 1, 1);
  const libDir = join(home, ".local/lib/claude-desktop");
  mkdirSync(libDir, { recursive: true });
  const f = ["_materialise_profile_binary", "_mirror_profile_siblings",
             "_canonical_electron_bin", "_refresh_profile_binary_if_stale"];
  // Profile created from tree A (e.g. the previous Nix store path, still present).
  const setup = `_materialise_profile_binary "${treeA}" "${libDir}/claude-work" && ` +
    `_mirror_profile_siblings "${dirname(treeA)}" "${libDir}" claude`;
  runFns(f, setup, { ...baseEnv, HOME: home });
  const r = runFns(f,
    `profile_suffix=-work CLAUDE_PROFILE=work; _refresh_profile_binary_if_stale || true`,
    { ...baseEnv, HOME: home, CLAUDE_ELECTRON: treeB });
  check("resources now mirrors CLAUDE_ELECTRON's tree",
    readlinkSync(join(libDir, "resources")), join(dirname(treeB), "resources"));
  // Nix store files have mtime 1, so -nt never fires; the mirror mismatch must.
  check("refresh names the mirror mismatch", /mirror a different install/.test(r.err), true);
  const again = runFns(f,
    `profile_suffix=-work CLAUDE_PROFILE=work; _refresh_profile_binary_if_stale || true`,
    { ...baseEnv, HOME: home, CLAUDE_ELECTRON: treeB });
  check("second launch does not refresh again", /Refreshing/.test(again.err), false);
});

safe("L1 AppImage create-profile", () => {
  const root = join(scratch, "l1a");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const mount = fakeTree(join(root, "mount_abc", "usr/lib/claude-desktop"));
  const r = spawnSync(BASH, [launcherPath, "--create-profile=work"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: mount,
           CLAUDE_APPIMAGE_PATH: join(root, "Claude.AppImage"),
           XDG_RUNTIME_DIR: join(root, "run") },
    encoding: "utf8",
  });
  check("AppImage --create-profile refuses", r.status !== 0, true);
  check("refusal names the AppImage", /AppImage/.test(r.stderr), true);
  check("no per-profile binary was copied",
    existsSync(join(home, ".local/lib/claude-desktop/claude-work")), false);
});

// ---------------------------------------------------------------- L3
console.log("L3: XWayland is chosen by $DISPLAY, not by compositor name");
safe("L3", () => {
  const f = ["_resolve_platform_mode"];
  const mode = (env) => runFns(f, '_resolve_platform_mode; echo "$platform_mode"',
    { ...baseEnv, ...env }).out;
  check("X11 only", mode({ DISPLAY: ":0" }), "x11");
  check("Wayland default", mode({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" }), "wayland");
  check("XWayland forced with DISPLAY",
    mode({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0", CLAUDE_USE_XWAYLAND: "1" }), "xwayland");
  check("Niri + xwayland-satellite DISPLAY honours the force",
    mode({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":1", NIRI_SOCKET: "/run/niri.sock",
           XDG_CURRENT_DESKTOP: "niri", CLAUDE_USE_XWAYLAND: "1" }), "xwayland");
  check("XWayland forced without DISPLAY stays native",
    mode({ WAYLAND_DISPLAY: "wayland-1", CLAUDE_USE_XWAYLAND: "1" }), "wayland");
});

// ---------------------------------------------------------------- L4
console.log("L4: kwallet probe falls through a failing busctl");
safe("L4", () => {
  const f = ["_kwallet_available"];
  const bin = join(scratch, "l4");
  const probe = (tools) => {
    const dir = join(bin, Object.entries(tools).map(([k, v]) => `${k}${v}`).join("_") || "none");
    mkdirSync(dir, { recursive: true });
    for (const [tool, code] of Object.entries(tools)) {
      // "hang" stands in for kwalletd blocking until the 5 s D-Bus timeout.
      writeExe(join(dir, tool), code === "hang"
        ? "#!/bin/sh\n/bin/sleep 4\nexit 1\n" : `#!/bin/sh\nexit ${code}\n`);
    }
    return runFns(f, "_kwallet_available && echo yes || echo no",
      { PATH: dir }).out;
  };
  check("failing busctl, working dbus-send", probe({ busctl: 1, "dbus-send": 0 }), "yes");
  check("failing busctl + dbus-send, working gdbus",
    probe({ busctl: 1, "dbus-send": 1, gdbus: 0 }), "yes");
  check("every tool says no", probe({ busctl: 1, "dbus-send": 1, gdbus: 1 }), "no");
  check("no probe tool at all keeps the KDE default", probe({}), "yes");
  const t0 = Date.now();
  check("a timed-out busctl settles that version without retrying",
    probe({ busctl: "hang", "dbus-send": 0 }), "no");
  check("timed-out probes are not repeated per tool", Date.now() - t0 < 12000, true);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(1);
}
