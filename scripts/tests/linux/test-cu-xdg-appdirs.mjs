#!/usr/bin/env node
// Computer Use app discovery follows the XDG base-dir spec, and tool detection
// does not depend on `which`.
//
// WHY THIS EXISTS
// ---------------
// js/cu_linux_executor.js hardcoded four application dirs (/usr/share, the
// user's ~/.local/share and the two flatpak export dirs). XDG_DATA_DIRS was
// ignored, so on NixOS (~/.nix-profile/share, /run/current-system/sw/share),
// with snap (/var/lib/snapd/desktop) and for anything in /usr/local, the apps
// were missing from list_installed_apps and open_application said "not found".
// Tool detection (_hasCmd) shelled out to `which`, which minimal installs do not
// ship - there every tool read as missing - and it cost a synchronous spawn per
// tool on the main process.
//
// This harness loads the REAL executor (child_process and electron stubbed, the
// real fs against temp dirs) and pins:
//
//   1. app dirs = $XDG_DATA_HOME (default ~/.local/share), then every
//      $XDG_DATA_DIRS entry (default /usr/local/share:/usr/share), then the
//      flatpak exports, deduped, each + /applications; relative entries ignored;
//   2. list + open see apps from all of them, and a user entry overrides a
//      system entry with the same desktop-file ID;
//   3. _hasCmd walks PATH with an X_OK check: an executable is found, a
//      non-executable file is not, and `which` is never spawned.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import * as realFs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const EXECUTOR = path.join(ROOT, "js", "cu_linux_executor.js");

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { failures.push(msg); console.log("  FAIL " + msg); }
}

const TMP = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-xdg-"));
const HOME = path.join(TMP, "home");
const DATA_HOME = path.join(TMP, "datahome");
const NIX = path.join(TMP, "nix-profile", "share");
const LOCAL = path.join(TMP, "usr-local", "share");
const BIN = path.join(TMP, "bin");
function desktop(dir, id, name, exec) {
  mkdirSync(path.join(dir, "applications"), { recursive: true });
  writeFileSync(path.join(dir, "applications", id + ".desktop"),
    "[Desktop Entry]\nType=Application\nName=" + name + "\nExec=" + exec + "\n");
}
desktop(DATA_HOME, "mine", "Mine App", "mine");
desktop(DATA_HOME, "dup", "User Dup", "userdup");
desktop(NIX, "nixapp", "Nix App", "/nix/store/abc-nixapp/bin/nixapp %U");
desktop(NIX, "dup", "System Dup", "sysdup");
desktop(LOCAL, "localapp", "Local App", "localapp");
desktop(path.join(HOME, ".local", "share", "flatpak", "exports", "share"), "org.flat.App", "Flat App", "flatpak run org.flat.App");
mkdirSync(BIN);
writeFileSync(path.join(BIN, "xdg-open"), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(BIN, "xdg-open"), 0o755);
writeFileSync(path.join(BIN, "spectacle"), "not executable\n"); chmodSync(path.join(BIN, "spectacle"), 0o644);

function load(env) {
  const calls = { sync: [], spawn: [], readdir: [] };
  const cp = {
    execFileSync(bin, args) { calls.sync.push(path.basename(String(bin))); throw new Error("not found"); },
    execSync(cmd) { calls.sync.push("sh:" + cmd); throw new Error("not found"); },
    spawnSync(bin) { calls.sync.push(path.basename(String(bin))); return { status: 1 }; },
    execFile(b, a, o, cb) { setTimeout(() => cb(new Error("no"), "", ""), 0); },
    spawn(bin, args) { calls.spawn.push([bin, ...(args || [])]); return { on() {}, unref() {} }; }
  };
  const fs = new Proxy(realFs, {
    get(t, p) {
      if (p === "readdirSync") return (d, ...r) => { calls.readdir.push(String(d)); return t.readdirSync(d, ...r); };
      return t[p];
    }
  });
  const electron = {
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, size: { width: 800, height: 600 }, scaleFactor: 1, label: "d" }],
      getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, size: { width: 800, height: 600 }, scaleFactor: 1 }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 })
    },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} }
  };
  const req = (id) => ({ child_process: cp, electron, path, os, fs })[id] ||
    (() => { throw new Error("unexpected require " + id); })();
  const saved = { ...process.env };
  const diag = [];
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuKwinMode = false;
  for (const k of ["XDG_DATA_HOME", "XDG_DATA_DIRS", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET",
    "X11_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "COWORK_SCREENSHOT_CMD", "YDOTOOL_SOCKET"]) delete process.env[k];
  // Exotic Wayland with no bridges: openApp takes the launch-only path.
  Object.assign(process.env, { HOME, PATH: BIN, XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0",
    XDG_CURRENT_DESKTOP: "KDE", XDG_RUNTIME_DIR: TMP }, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  new Function("require", "process", readFileSync(EXECUTOR, "utf8"))(req, process);
  const ex = globalThis.__linuxExecutor;
  const restore = () => {
    delete globalThis.__linuxExecutor; delete globalThis.__isVM; delete globalThis.__cdbDiag; delete globalThis.__cuKwinMode;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
  return { ex, calls, diag, restore };
}

const appDirsRead = (calls) => calls.readdir.filter((d) => /applications\/?$/.test(d));

async function testXdgDirs() {
  console.log("\n[1] app dirs follow XDG_DATA_HOME + XDG_DATA_DIRS + flatpak, deduped");
  const r = load({ XDG_DATA_HOME: DATA_HOME, XDG_DATA_DIRS: NIX + ":relative/share:" + LOCAL + ":" + NIX + "/:" });
  try {
    const apps = await r.ex.listInstalledApps();
    const names = new Set(apps.map((a) => a.displayName));
    ok(names.has("Mine App"), "XDG_DATA_HOME app listed");
    ok(names.has("Nix App"), "XDG_DATA_DIRS (Nix profile) app listed");
    ok(names.has("Local App"), "XDG_DATA_DIRS (/usr/local-like) app listed");
    ok(names.has("Flat App"), "flatpak user export listed even though it is not in XDG_DATA_DIRS");
    const dirs = appDirsRead(r.calls);
    ok(dirs[0] === path.join(DATA_HOME, "applications"), "XDG_DATA_HOME is searched first: " + dirs[0]);
    ok(dirs.indexOf(path.join(NIX, "applications")) < dirs.indexOf(path.join(LOCAL, "applications")),
       "XDG_DATA_DIRS order is kept");
    const norm = dirs.map((d) => path.resolve(d));
    ok(norm.length === new Set(norm).size, "no dir is read twice (dedupe): " + dirs.join(", "));
    ok(!dirs.some((d) => d.includes("relative/share")), "a relative XDG_DATA_DIRS entry is ignored");

    r.calls.spawn.length = 0;
    const res = await r.ex.openApp("Nix App");
    ok(res && res.action === "opened", "openApp resolves an XDG_DATA_DIRS app: " + JSON.stringify(res));
    ok(r.calls.spawn.some((c) => c.includes("/nix/store/abc-nixapp/bin/nixapp")),
       "and launches its Exec: " + JSON.stringify(r.calls.spawn));
    r.calls.spawn.length = 0;
    await r.ex.openApp("dup");
    ok(r.calls.spawn.some((c) => c.includes("userdup")) && !r.calls.spawn.some((c) => c.includes("sysdup")),
       "a user entry overrides a system entry with the same desktop-file ID: " + JSON.stringify(r.calls.spawn));
  } finally { r.restore(); }
}

async function testDefaults() {
  console.log("\n[2] spec defaults when the variables are unset or empty");
  const r = load({ XDG_DATA_HOME: undefined, XDG_DATA_DIRS: "" });
  try {
    await r.ex.listInstalledApps();
    const dirs = appDirsRead(r.calls);
    const want = [path.join(HOME, ".local", "share", "applications"), "/usr/local/share/applications",
      "/usr/share/applications"];
    ok(JSON.stringify(dirs.slice(0, 3)) === JSON.stringify(want),
       "~/.local/share, /usr/local/share, /usr/share in that order: " + dirs.slice(0, 3).join(", "));
    ok(dirs.includes("/var/lib/flatpak/exports/share/applications") &&
       dirs.includes(path.join(HOME, ".local", "share", "flatpak", "exports", "share", "applications")),
       "both flatpak export dirs are included");
  } finally { r.restore(); }
}

async function testHasCmd() {
  console.log("\n[3] tool detection walks PATH (X_OK), never spawns `which`");
  const r = load({ XDG_DATA_HOME: DATA_HOME });
  try {
    ok(!r.calls.sync.includes("which"), "`which` was never spawned: " + r.calls.sync.join(", "));
    const avail = r.diag.find((l) => l.includes("diagnostics: available=")) || "";
    const missing = r.diag.find((l) => l.includes("diagnostics: missing=")) || "";
    ok(/available=\[[^\]]*xdg-open/.test(avail), "an executable on PATH is found: " + avail);
    ok(/missing=\[[^\]]*spectacle/.test(missing), "a non-executable file of the same name is not: " + missing);
    ok(/missing=\[[^\]]*convert/.test(missing), "an absent tool is missing");
  } finally { r.restore(); }
}

async function main() {
  try {
    await testXdgDirs();
    await testDefaults();
    await testHasCmd();
  } catch (e) {
    console.error("\nHARNESS ERROR: " + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
  console.log("");
  if (failures.length) {
    console.log("FAILED " + failures.length + " of " + (pass + failures.length) + " checks:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log("ALL " + pass + " CHECKS PASSED");
}

main();
