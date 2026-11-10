#!/usr/bin/env node
// Launcher side of the per-profile window identity (issue #319).
//
// A named profile's windows carry app_id / WM_CLASS com.anthropic.Claude-<name>
// when its per-profile .desktop exists, so the files the launcher writes must
// say the same thing:
//   - --create-profile writes StartupWMClass=com.anthropic.Claude-<name>
//   - a launch heals an old file that still says the shared class (only that
//     line; a user-edited Icon= survives), leaves a correct file alone, and
//     never creates one
//   - the AppImage entry for a named profile starts THAT profile, does not
//     claim claude:// and never runs `xdg-mime default`
//   - with no profile, every written file and message is byte-identical to the
//     launcher at HEAD (compared against `git show HEAD:...`)
//
// Exit codes: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync,
         statSync, readdirSync, lstatSync, readlinkSync, mkdtempSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const newLauncher = join(repo, "scripts", "claude-desktop-launcher.sh");

const BASH = (spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout || "").trim();
if (!BASH) { console.log("SKIP: bash not found"); process.exit(3); }

const scratch = mkdtempSync(join(process.env.CDB_TEST_TMP || tmpdir(), "launcher-profdesk-"));
process.on("exit", () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

// The launcher at HEAD is the "before" reference for the default-profile diff.
const oldLauncher = join(scratch, "old-launcher.sh");
const gs = spawnSync("git", ["-C", repo, "show", "HEAD:scripts/claude-desktop-launcher.sh"],
                     { encoding: "utf8", maxBuffer: 64 << 20 });
if (gs.status !== 0) { console.log("SKIP: git show HEAD failed"); process.exit(3); }
writeFileSync(oldLauncher, gs.stdout);
chmodSync(oldLauncher, 0o755);

// The launcher skips AppImage integration when a system package already owns the
// default .desktop, which a developer host often has. Both launchers of the
// default-profile comparison look for it in a path that never exists.
const noSystem = (src, dst) => {
  let text = readFileSync(src, "utf8");
  for (const [from, to] of [
    ['"/usr/share/applications/${DESKTOP_ID}.desktop"', '"$HOME/.no-system-apps/${DESKTOP_ID}.desktop"'],
    ['"/usr/share/applications/com.anthropic.Claude.desktop"', '"$HOME/.no-system-apps/src1.desktop"'],
    ['"/usr/share/applications/claude-desktop.desktop"', '"$HOME/.no-system-apps/src2.desktop"'],
  ]) text = text.split(from).join(to);
  writeFileSync(dst, text); chmodSync(dst, 0o755);
  return dst;
};
const oldIsolated = noSystem(oldLauncher, join(scratch, "old-isolated.sh"));
const newIsolated = noSystem(newLauncher, join(scratch, "new-isolated.sh"));

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS ${label}`); pass++; }
  else {
    console.log(`  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failures.push(label);
  }
}

function writeExe(p, body) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); chmodSync(p, 0o755); }

let n = 0;
// A fresh HOME + fake Electron tree + a PATH stub dir whose xdg-mime records its argv.
function world() {
  const root = join(scratch, `w${n++}`);
  const home = join(root, "home");
  const stub = join(root, "stub");
  const tree = join(root, "tree");
  mkdirSync(home, { recursive: true });
  writeExe(join(stub, "xdg-mime"), `#!/bin/sh\necho "$*" >> "${root}/xdg-mime.calls"\n`);
  writeExe(join(tree, "claude"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(tree, "version"), "44.4.3\n");
  mkdirSync(join(tree, "resources"), { recursive: true });
  writeFileSync(join(tree, "resources", "app.asar"), "asar");
  const appimage = join(root, "Claude.AppImage");
  writeExe(appimage, "#!/bin/sh\nexit 0\n");
  const run = (launcher, args, extra = {}) => spawnSync(BASH, [launcher, ...args], {
    env: { PATH: `${stub}:/usr/bin:/bin`, HOME: home, CLAUDE_ELECTRON: join(tree, "claude"),
           XDG_RUNTIME_DIR: join(root, "run"), DISPLAY: ":99", CLAUDE_KEEP_TTY: "1",
           CLAUDE_PROFILE_QUIET: "1", ...extra },
    encoding: "utf8", timeout: 90000,
  });
  const calls = () => (existsSync(join(root, "xdg-mime.calls")) ? readFileSync(join(root, "xdg-mime.calls"), "utf8") : "");
  return { root, home, appimage, run, calls, apps: join(home, ".local", "share", "applications") };
}
function tree(dir) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink()) out[p.slice(dir.length)] = `l:${readlinkSync(p)}`;
      else out[p.slice(dir.length)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}
const line = (text, key) => (text.split("\n").find((l) => l.startsWith(key)) || "");
const OLD_FILE = (icon) => `[Desktop Entry]
Name=Claude (work)
Exec=/usr/bin/claude-desktop --profile=work %u
Icon=${icon}
Terminal=false
Type=Application
StartupWMClass=com.anthropic.Claude
Categories=Utility;Development;
X-Custom=keep-me
`;

console.log("T1: --create-profile writes the per-profile StartupWMClass");
for (const withSource of [false, true]) {
  const w = world();
  if (withSource) {
    mkdirSync(w.apps, { recursive: true });
    writeFileSync(join(w.apps, "com.anthropic.Claude.desktop"),
      "[Desktop Entry]\nName=Claude\nExec=claude-desktop %U\nIcon=claude-desktop\nStartupWMClass=com.anthropic.Claude\nMimeType=x-scheme-handler/claude;\nActions=NewChat;\n\n[Desktop Action NewChat]\nName=New chat\nExec=claude-desktop claude://claude.ai/new\n");
  }
  const r = w.run(newIsolated, ["--create-profile=work"]);
  check(`create exit status (source=${withSource})`, r.status, 0);
  const f = join(w.apps, "com.anthropic.Claude-work.desktop");
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  check(`StartupWMClass is per-profile (source=${withSource})`, line(text, "StartupWMClass="), "StartupWMClass=com.anthropic.Claude-work");
  check(`exactly one StartupWMClass (source=${withSource})`, text.split("\n").filter((l) => l.startsWith("StartupWMClass=")).length, 1);
}

console.log("T2: a launch heals an old-style file, nothing else");
{
  const w = world();
  mkdirSync(w.apps, { recursive: true });
  const f = join(w.apps, "com.anthropic.Claude-work.desktop");
  writeFileSync(f, OLD_FILE("/home/me/my-icon.png"));
  const r = w.run(newLauncher, ["--profile=work"]);
  check("launch exit status", r.status, 0);
  check("healed file is the old file with only that line changed", readFileSync(f, "utf8"),
    OLD_FILE("/home/me/my-icon.png").replace("StartupWMClass=com.anthropic.Claude\n", "StartupWMClass=com.anthropic.Claude-work\n"));
  check("no temp file left behind", readdirSync(w.apps).join(","), "com.anthropic.Claude-work.desktop");
}

console.log("T2b: heal shapes, mode, symlinks");
{
  const want = (t, v) => t.replace(/StartupWMClass=[^\r\n]*/, `StartupWMClass=${v}`);
  // older launchers wrote other classes
  for (const old of ["claude-desktop", "claude-work"]) {
    const w = world();
    mkdirSync(w.apps, { recursive: true });
    const f = join(w.apps, "com.anthropic.Claude-work.desktop");
    writeFileSync(f, want(OLD_FILE("x"), old));
    w.run(newLauncher, ["--profile=work"]);
    check(`StartupWMClass=${old} is healed`, readFileSync(f, "utf8"), want(OLD_FILE("x"), "com.anthropic.Claude-work"));
  }
  { // CRLF file keeps its line endings
    const w = world();
    mkdirSync(w.apps, { recursive: true });
    const f = join(w.apps, "com.anthropic.Claude-work.desktop");
    const crlf = OLD_FILE("x").replace(/\n/g, "\r\n");
    writeFileSync(f, crlf);
    w.run(newLauncher, ["--profile=work"]);
    check("CRLF file: only the class value changes", readFileSync(f, "utf8"),
      crlf.replace("StartupWMClass=com.anthropic.Claude\r\n", "StartupWMClass=com.anthropic.Claude-work\r\n"));
  }
  { // no StartupWMClass line: untouched
    const w = world();
    mkdirSync(w.apps, { recursive: true });
    const f = join(w.apps, "com.anthropic.Claude-work.desktop");
    const t = OLD_FILE("x").replace(/StartupWMClass=[^\n]*\n/, "");
    writeFileSync(f, t);
    w.run(newLauncher, ["--profile=work"]);
    check("file without StartupWMClass is untouched", readFileSync(f, "utf8"), t);
  }
  { // mode preserved
    const w = world();
    mkdirSync(w.apps, { recursive: true });
    const f = join(w.apps, "com.anthropic.Claude-work.desktop");
    writeFileSync(f, OLD_FILE("x")); chmodSync(f, 0o755);
    w.run(newLauncher, ["--profile=work"]);
    check("healed file is changed", /Claude-work\n/.test(readFileSync(f, "utf8").split("StartupWMClass=")[1]), true);
    check("0755 stays 0755", statSync(f).mode & 0o777, 0o755);
  }
  { // symlink left alone
    const w = world();
    mkdirSync(w.apps, { recursive: true });
    const target = join(w.root, "elsewhere.desktop");
    writeFileSync(target, OLD_FILE("x"));
    const f = join(w.apps, "com.anthropic.Claude-work.desktop");
    symlinkSync(target, f);
    w.run(newLauncher, ["--profile=work"]);
    check("symlinked file: target untouched", readFileSync(target, "utf8"), OLD_FILE("x"));
    check("symlink still a symlink", lstatSync(f).isSymbolicLink(), true);
  }
}

console.log("T3: a correct file is not rewritten");
{
  const w = world();
  mkdirSync(w.apps, { recursive: true });
  const f = join(w.apps, "com.anthropic.Claude-work.desktop");
  writeFileSync(f, OLD_FILE("x").replace("StartupWMClass=com.anthropic.Claude\n", "StartupWMClass=com.anthropic.Claude-work\n"));
  const old = new Date(2020, 0, 1);
  spawnSync("touch", ["-d", "2020-01-01", f]);
  const before = statSync(f);
  const r = w.run(newLauncher, ["--profile=work"]);
  const after = statSync(f);
  check("launch exit status", r.status, 0);
  check("inode unchanged", after.ino, before.ino);
  check("mtime unchanged", after.mtimeMs, before.mtimeMs);
  void old;
}

console.log("T4: no file is created, and foreign files are left alone");
{
  const w = world();
  const r = w.run(newLauncher, ["--profile=work"]);
  check("launch exit status", r.status, 0);
  check("no per-profile .desktop created", existsSync(join(w.apps, "com.anthropic.Claude-work.desktop")), false);
  // A file of the right name whose Exec does not start this profile is not ours.
  mkdirSync(w.apps, { recursive: true });
  const f = join(w.apps, "com.anthropic.Claude-work.desktop");
  const foreign = OLD_FILE("x").replace("--profile=work", "--something-else");
  writeFileSync(f, foreign);
  w.run(newLauncher, ["--profile=work"]);
  check("foreign file untouched", readFileSync(f, "utf8"), foreign);
}

console.log("T5: AppImage integration for a named profile");
{
  const w = world();
  const r = w.run(newLauncher, ["--profile=work", "--integrate"], { CLAUDE_APPIMAGE_PATH: w.appimage });
  check("integrate exit status", r.status, 0);
  const f = join(w.apps, "com.anthropic.Claude-work.desktop");
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  check("Exec carries --profile", line(text, "Exec="), `Exec=${w.appimage} --profile=work %u`);
  check("Name distinguishes the profile", line(text, "Name="), "Name=Claude (work)");
  check("StartupWMClass is per-profile", line(text, "StartupWMClass="), "StartupWMClass=com.anthropic.Claude-work");
  check("no MimeType", line(text, "MimeType="), "");
  check("no scheme handler anywhere", /x-scheme-handler/.test(text), false);
  check("no Actions (their Exec would open the default profile)", /Actions=|\[Desktop Action/.test(text), false);
  check("xdg-mime default was not run", /^default /m.test(w.calls()), false);
  const r2 = w.run(newLauncher, ["--profile=work", "--integrate"], { CLAUDE_APPIMAGE_PATH: w.appimage });
  check("second integrate reports up to date", /already up to date/.test(r2.stdout), true);
  check("still no xdg-mime default call", /^default /m.test(w.calls()), false);
  // An old-style file (no --profile, scheme handler) is rewritten.
  writeFileSync(f, `[Desktop Entry]\nName=Claude\nExec=${w.appimage} %u\nStartupWMClass=com.anthropic.Claude\nMimeType=x-scheme-handler/claude;\n`);
  w.run(newLauncher, ["--profile=work", "--integrate"], { CLAUDE_APPIMAGE_PATH: w.appimage });
  const text3 = readFileSync(f, "utf8");
  check("old AppImage profile entry is replaced", line(text3, "Exec=") + "|" + line(text3, "MimeType="),
    `Exec=${w.appimage} --profile=work %u|`);
}

console.log("T6: default profile is byte-identical to the launcher at HEAD");
{
  const outs = {};
  for (const [tag, launcher] of [["old", oldIsolated], ["new", newIsolated]]) {
    const w = world();
    const integ = w.run(launcher, ["--integrate"], { CLAUDE_APPIMAGE_PATH: w.appimage });
    const integ2 = w.run(launcher, ["--integrate"], { CLAUDE_APPIMAGE_PATH: w.appimage });
    const launch = w.run(launcher, [], { CLAUDE_APPIMAGE_PATH: w.appimage });
    const strip = (s) => s.split(w.root).join("<ROOT>");
    outs[tag] = JSON.stringify({
      statuses: [integ.status, integ2.status, launch.status],
      stdout: [integ.stdout, integ2.stdout, launch.stdout].map(strip),
      files: Object.fromEntries(Object.entries(tree(join(w.home, ".local"))).map(([k, v]) => [k, strip(v)])),
      xdgMime: strip(w.calls()),
    });
  }
  check("default AppImage integrate: files, output and xdg-mime calls identical", outs.new, outs.old);
  check("default integrate wrote the desktop file", /com\.anthropic\.Claude\.desktop/.test(outs.new), true);
  check("default integrate ran xdg-mime default", /default com\.anthropic\.Claude\.desktop x-scheme-handler\/claude/.test(outs.new), true);

  const outs2 = {};
  for (const [tag, launcher] of [["old", oldLauncher], ["new", newLauncher]]) {
    const w = world();
    mkdirSync(w.apps, { recursive: true });
    writeFileSync(join(w.apps, "com.anthropic.Claude.desktop"), "[Desktop Entry]\nName=Claude\nStartupWMClass=com.anthropic.Claude\nExec=claude-desktop %U\n");
    const launch = w.run(launcher, []);
    outs2[tag] = JSON.stringify({ s: launch.status, f: tree(w.apps), h: Object.keys(tree(w.home)).filter((k) => !k.includes("/.cache/")).length });
  }
  check("default launch leaves a default .desktop untouched, same as HEAD", outs2.new, outs2.old);
  check("default .desktop keeps the shared class", /StartupWMClass=com\.anthropic\.Claude\\n/.test(outs2.new), true);
}

console.log("T6b: default AppImage entry with an older class is left as at HEAD");
{
  const outs = {};
  for (const [tag, launcher] of [["old", oldIsolated], ["new", newIsolated]]) {
    const w = world();
    mkdirSync(w.apps, { recursive: true });
    const f = join(w.apps, "com.anthropic.Claude.desktop");
    writeFileSync(f, `[Desktop Entry]\nName=Claude\nExec=${w.appimage} %u\nStartupWMClass=claude-desktop\nMimeType=x-scheme-handler/claude;application/vnd.anthropic.mcpb;application/vnd.anthropic.skill;\n`);
    // Exec/MimeType already match what the launcher wants
    const r = w.run(launcher, ["--integrate"], { CLAUDE_APPIMAGE_PATH: w.appimage });
    const strip = (x) => x.split(w.root).join("<ROOT>");
    outs[tag] = JSON.stringify({ s: r.status, out: strip(r.stdout), file: strip(readFileSync(f, "utf8")), calls: strip(w.calls()) });
  }
  check("old-class default file: output, file and xdg-mime calls identical to HEAD", outs.new, outs.old);
  check("it was treated as up to date", /already up to date/.test(outs.new), true);
}

console.log("T7: a named profile hands a stale claude:// default back");
{
  // stub xdg-mime answering `query default` from a state file, recording calls
  const mk = (seed, withDefaultFile) => {
    const w = world();
    const state = join(w.root, "handler");
    if (seed) writeFileSync(state, seed + "\n");
    writeExe(join(w.root, "stub", "xdg-mime"), `#!/bin/sh
echo "$*" >> "${w.root}/xdg-mime.calls"
if [ "$1" = query ]; then [ -f "${state}" ] && cat "${state}"; exit 0; fi
if [ "$1" = default ]; then echo "$2" > "${state}"; fi
`);
    if (withDefaultFile) {
      mkdirSync(w.apps, { recursive: true });
      writeFileSync(join(w.apps, "com.anthropic.Claude.desktop"), "[Desktop Entry]\nName=Claude\n");
    }
    return { w, state };
  };
  const env = (w) => ({ CLAUDE_APPIMAGE_PATH: w.appimage, XDG_DATA_DIRS: join(w.root, "no-data-dirs") });
  {
    const { w, state } = mk("com.anthropic.Claude-work.desktop", true);
    const r = w.run(newLauncher, ["--profile=work", "--integrate"], env(w));
    check("seeded default pointing at the profile: reset to the default file", readFileSync(state, "utf8").trim(), "com.anthropic.Claude.desktop");
    check("reset is an xdg-mime default call", /default com\.anthropic\.Claude\.desktop x-scheme-handler\/claude/.test(w.calls()), true);
    check("message says the handler stays with the default profile", /stays with the default profile/.test(r.stdout), true);
  }
  {
    const { w, state } = mk("com.anthropic.Claude-work.desktop", false);
    const r = w.run(newLauncher, ["--profile=work", "--integrate"], env(w));
    check("no default file on disk: no reset", readFileSync(state, "utf8").trim(), "com.anthropic.Claude-work.desktop");
    check("no default file: no xdg-mime default call", /^default /m.test(w.calls()), false);
    check("no default file: message does not claim it", /stays with the default profile/.test(r.stdout), false);
  }
  {
    // An up-to-date named-profile launch spawns no xdg-mime at all.
    const { w } = mk("com.anthropic.Claude-work.desktop", true);
    w.run(newLauncher, ["--profile=work", "--integrate"], env(w));
    writeFileSync(join(w.root, "xdg-mime.calls"), "");
    const r = w.run(newLauncher, ["--profile=work", "--integrate"], env(w));
    check("second (up-to-date) named launch: already up to date", /already up to date/.test(r.stdout), true);
    check("second (up-to-date) named launch: no xdg-mime call at all", w.calls(), "");
  }
  {
    const { w } = mk("com.anthropic.Claude.desktop", true);
    w.run(newLauncher, ["--profile=work", "--integrate"], env(w));
    check("default pointing elsewhere: no xdg-mime default call", /^default /m.test(w.calls()), false);
  }
}

console.log(`\n${failures.length ? "FAIL" : "PASS"}: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
