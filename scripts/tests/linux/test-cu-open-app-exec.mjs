#!/usr/bin/env node
// Computer Use open_application launches a .desktop entry with its FULL Exec argv.
//
// WHY THIS EXISTS (issue #297)
// ----------------------------
// js/cu_linux_executor.js parsed Exec with /^Exec=(\S+)/m: only the first token
// survived, so a Flatpak entry spawned a bare `flatpak`, a Chromium web app lost
// its --app= flag, and `env FOO=bar app` spawned `env`. listInstalledApps
// published wrapper names (env, flatpak, ...) as app aliases.
//
// This harness loads the REAL executor (child_process and electron stubbed, the
// real fs against temp dirs) and pins, per the Desktop Entry spec:
//
//   1. one shared parser: [Desktop Entry] group only, first plain Exec, string
//      escapes, quote-aware argv split, field codes (%f %U dropped, %i -> --icon
//      <Icon>, %c -> Name, %k -> file, %% -> %), malformed -> launcher tools;
//   2. launch = direct argv ["setsid", argv0, ...args] (argv0 itself, detached,
//      when setsid is missing), cwd = Path=, never a shell, D-Bus activatable
//      entries with an Exec included;
//   3. launcher tools (gio, gtk-launch, kioclient, exo-open, terminals) are only
//      the fallback for no-Exec / Terminal=true / malformed / a missing binary
//      (spawn error event), each probed on PATH, and all absent is a clear error;
//   4. TryExec that does not resolve hides the entry;
//   5. listInstalledApps lists each app under its desktop-file id (the canonical
//      app id, test-cu-app-ids.mjs), with its real argv0 as an alias row and never
//      a wrapper name; _resolveApp prefers a name/desktop-id match over a basename.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import * as realFs from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const EXECUTOR = process.env.CU_EXECUTOR || path.join(ROOT, "js", "cu_linux_executor.js");

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { failures.push(msg); console.log("  FAIL " + msg); }
}
const J = (v) => JSON.stringify(v);
function eq(got, want, msg) { ok(J(got) === J(want), msg + (J(got) === J(want) ? "" : "\n      got  " + J(got) + "\n      want " + J(want))); }

const TMP = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-openapp-"));
const HOME = path.join(TMP, "home");
mkdirSync(HOME, { recursive: true });
const OPT = path.join(TMP, "opt");
mkdirSync(path.join(OPT, "My App"), { recursive: true });
let seq = 0;
const DEFAULT_OPTS = { detached: true, stdio: "ignore" };
const TOOLS = new Set(["gio", "gtk-launch", "kioclient6", "kioclient5", "exo-open"]);

function exe(file) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "#!/bin/sh\nexit 0\n"); chmodSync(file, 0o755); }
function makeBin(names) {
  const dir = path.join(TMP, "bin" + (++seq));
  mkdirSync(dir);
  for (const n of names) exe(path.join(dir, n));
  return dir;
}
const BASE_TOOLS = ["setsid", "flatpak", "env", "chromium", "brave", "firefox", "htop", "fc", "plain", "flaky"];
exe(path.join(OPT, "My App", "run"));
exe(path.join(OPT, "snapbin", "firefox"));

// Build a data dir with the given entries ({id: content}); `@FILE@`, `@BIN@` and
// `@OPT@` are substituted. Returns {data, file(id)}.
function dataDir(entries, bin) {
  const data = path.join(TMP, "data" + (++seq));
  const apps = path.join(data, "applications");
  mkdirSync(apps, { recursive: true });
  for (const [id, body] of Object.entries(entries)) {
    writeFileSync(path.join(apps, id + ".desktop"),
      body.replace(/@BIN@/g, bin).replace(/@OPT@/g, OPT).replace(/@FILE@/g, path.join(apps, id + ".desktop")));
  }
  return { data, file: (id) => path.join(apps, id + ".desktop") };
}

// load(): the executor with a recording child_process. `behave(cmd, args)` may
// return {error:true} (spawn error event) or {exit:N} (tool exit status).
function load(env, behave) {
  const calls = { spawn: [], readdir: [] };
  const cp = {
    execFileSync() { throw new Error("not found"); },
    execSync() { throw new Error("not found"); },
    spawnSync() { return { status: 1 }; },
    execFile(b, a, o, cb) { setTimeout(() => cb(new Error("no"), "", ""), 0); },
    spawn(cmd, args, opts) {
      calls.spawn.push({ argv: [cmd, ...(args || [])], opts });
      const child = new EventEmitter();
      child.unref = () => {};
      const b = (behave && behave(cmd, args || [])) || {};
      setImmediate(() => {
        if (b.error) { const e = new Error("spawn " + cmd + " ENOENT"); e.code = "ENOENT"; child.emit("error", e); return; }
        child.emit("spawn");
        if (TOOLS.has(path.basename(cmd))) setImmediate(() => child.emit("exit", b.exit || 0, null));
      });
      return child;
    }
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
  for (const k of ["XDG_DATA_HOME", "XDG_DATA_DIRS", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "TERMINAL",
    "X11_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "COWORK_SCREENSHOT_CMD", "YDOTOOL_SOCKET"]) delete process.env[k];
  // Exotic Wayland with no bridges: openApp takes the launch-only path.
  Object.assign(process.env, { HOME, USER: "tester", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0",
    XDG_CURRENT_DESKTOP: "KDE", XDG_RUNTIME_DIR: TMP, XDG_DATA_DIRS: path.join(TMP, "empty") }, env);
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

// One scenario: entries + a PATH of the named tools, then run fn(rig, dd).
async function withApps(entries, tools, fn, behave) {
  const bin = makeBin(tools);
  const dd = dataDir(entries, bin);
  const r = load({ PATH: bin, XDG_DATA_HOME: dd.data }, behave);
  try { return await fn(r, dd, bin); } finally { r.restore(); }
}
async function launch(entries, name, tools, behave) {
  return withApps(entries, tools, async (r, dd, bin) => {
    let res, err;
    try { res = await r.ex.openApp(name); } catch (e) { err = e; }
    return { res, err, spawn: r.calls.spawn, diag: r.diag, dd, bin };
  }, behave);
}
const argvs = (l) => l.spawn.map((c) => c.argv);

const HDR = "[Desktop Entry]\nType=Application\n";

async function testArgvShapes() {
  console.log("\n[1] direct argv: Flatpak, web app, env + quoted path, field codes, Path, Desktop Action");

  let l = await launch({ calc: HDR + "Name=Calculator\nExec=flatpak run --branch=stable --arch=x86_64 --command=gnome-calculator org.gnome.Calculator @@u %U @@\n" },
    "Calculator", BASE_TOOLS);
  eq(argvs(l), [["setsid", "flatpak", "run", "--branch=stable", "--arch=x86_64", "--command=gnome-calculator", "org.gnome.Calculator", "@@u", "@@"]],
    "Flatpak entry spawns its full argv (%U dropped, @@u/@@ kept)");
  eq(l.spawn[0].opts, DEFAULT_OPTS, "options are exactly {detached, stdio:ignore} (no cwd without Path=)");
  ok(l.res && l.res.action === "opened", "return shape is unchanged: " + J(l.res));
  ok(l.diag.some((d) => d.includes("[claude-cu] openApp: launching argv ") && d.includes(J(["setsid", "flatpak", "run"]).slice(1, -1))),
    "the diag line carries the full argv");

  l = await launch({ web: HDR + 'Name=Docs App\nExec=@BIN@/chromium --app=https://docs.example/ --profile-directory="Profile 1"\n' },
    "Docs App", BASE_TOOLS);
  eq(argvs(l), [["setsid", path.join(l.bin, "chromium"), "--app=https://docs.example/", "--profile-directory=Profile 1"]],
    "Chromium web app keeps --app and the quoted profile dir as ONE argument");

  l = await launch({ envq: HDR + 'Name=Quoted\nExec=env FOO=bar "@OPT@/My App/run" --x="a b" %U\n' }, "Quoted", BASE_TOOLS);
  eq(argvs(l), [["setsid", "env", "FOO=bar", path.join(OPT, "My App", "run"), "--x=a b"]],
    "env + quoted path with a space + --x=\"a b\"");

  l = await launch({ fc: HDR + "Name=Field Codes\nIcon=myicon\nExec=fc %% %c %k %i %f\n" }, "Field Codes", BASE_TOOLS);
  eq(argvs(l), [["setsid", "fc", "%", "Field Codes", l.dd.file("fc"), "--icon", "myicon"]],
    "%% -> %, %c -> Name, %k -> file path, %i -> --icon <Icon>, %f dropped");

  l = await launch({ fc2: HDR + "Name=No Icon\nExec=fc %i pre%Ufix --a=%u\n" }, "No Icon", BASE_TOOLS);
  eq(argvs(l), [["setsid", "fc", "prefix", "--a="]], "%i without Icon dropped; in-word %U removed");

  l = await launch({ cwd: HDR + "Name=Cwd App\nPath=/tmp\nExec=plain\n" }, "Cwd App", BASE_TOOLS);
  eq(argvs(l), [["setsid", "plain"]], "Path= app: argv");
  eq(l.spawn[0].opts, { detached: true, stdio: "ignore", cwd: "/tmp" }, "Path=/tmp becomes the spawn cwd");

  l = await launch({ act: HDR + "Name=Actions\nName[de]=Aktionen\nExec[de]=wrong\nExec=@BIN@/plain --main\nActions=new;\n\n[Desktop Action new]\nName=New\nExec=@BIN@/plain --new-window\n" },
    "Actions", BASE_TOOLS);
  eq(argvs(l), [["setsid", path.join(l.bin, "plain"), "--main"]], "a localized Exec[..] and a [Desktop Action] Exec are ignored");

  l = await launch({ esc: HDR + "Name=Escapes\nExec=plain a\\sb\n" }, "Escapes", BASE_TOOLS);
  eq(argvs(l), [["setsid", "plain", "a", "b"]], "the string escape \\s is applied before the split (becomes a separator)");
}

async function testDbus() {
  console.log("\n[2] DBusActivatable: with Exec = direct argv, without Exec = gio");
  let l = await launch({ dw: HDR + "Name=Dbus With\nDBusActivatable=true\nExec=@BIN@/plain --gapplication-service\n" }, "Dbus With", [...BASE_TOOLS, "gio"]);
  eq(argvs(l), [["setsid", path.join(l.bin, "plain"), "--gapplication-service"]], "DBusActivatable + Exec launches the Exec argv, no launcher tool");

  l = await launch({ dn: HDR + "Name=Dbus Bare\nDBusActivatable=true\n" }, "Dbus Bare", [...BASE_TOOLS, "gio"]);
  eq(argvs(l), [["gio", "launch", l.dd.file("dn")]], "DBusActivatable without Exec -> gio launch <file>");
  eq(l.spawn[0].opts, DEFAULT_OPTS, "gio spawn options");
  ok(l.res && l.res.action === "opened", "and the call still returns opened");

  l = await launch({ nx: HDR + "Name=Nothing\n" }, "Nothing", BASE_TOOLS);
  eq(argvs(l), [], "an entry with neither Exec nor DBusActivatable is not launchable (not listed): no spawn");
  ok(l.res && l.res.action === "not_found", "-> not_found: " + J(l.res));
}

async function testFallbackChain() {
  console.log("\n[3] fallback chain: Terminal=true, malformed Exec, missing binary, absent tools");
  const term = { t: HDR + "Name=Term App\nTerminal=true\nExec=@BIN@/htop --x\n" };
  let l = await launch(term, "Term App", [...BASE_TOOLS, "gio"]);
  eq(argvs(l), [["gio", "launch", l.dd.file("t")]], "Terminal=true -> gio launch (no direct spawn)");

  l = await launch(term, "Term App", [...BASE_TOOLS, "xdg-terminal-exec"]);
  eq(argvs(l), [["xdg-terminal-exec", path.join(l.bin, "htop"), "--x"]], "Terminal=true, no gio: xdg-terminal-exec + argv");
  l = await launch(term, "Term App", [...BASE_TOOLS, "x-terminal-emulator"]);
  eq(argvs(l), [["x-terminal-emulator", "-e", path.join(l.bin, "htop"), "--x"]], "then x-terminal-emulator -e + argv");
  {
    const bin = makeBin([...BASE_TOOLS, "myterm"]);
    const dd = dataDir(term, bin);
    const r = load({ PATH: bin, XDG_DATA_HOME: dd.data, TERMINAL: "myterm" });
    try { await r.ex.openApp("Term App"); eq(r.calls.spawn.map((c) => c.argv), [["myterm", "-e", path.join(bin, "htop"), "--x"]], "then $TERMINAL -e + argv"); }
    finally { r.restore(); }
  }

  for (const [label, body] of [["unterminated quote", 'Exec=@BIN@/plain "oops\n'], ["trailing lone backslash", "Exec=@BIN@/plain abc\\\n"], ["trailing lone %", "Exec=@BIN@/plain 100%\n"]]) {
    l = await launch({ m: HDR + "Name=Bad\n" + body }, "Bad", [...BASE_TOOLS, "gio"]);
    eq(argvs(l), [["gio", "launch", l.dd.file("m")]], "malformed Exec (" + label + ") -> gio launch, no direct spawn");
  }

  // Missing binary: spawn raises an error event, the next tier runs.
  l = await launch({ f: HDR + "Name=Flaky\nExec=@BIN@/flaky\n" }, "Flaky", [...BASE_TOOLS, "gio"],
    (cmd, args) => (cmd === "setsid" && /flaky$/.test(args[0]) ? { error: true } : null));
  eq(argvs(l), [["setsid", path.join(l.bin, "flaky")], ["gio", "launch", l.dd.file("f")]],
    "spawn error event on the direct launch -> gio launch runs next");
  ok(l.res && l.res.action === "opened", "and the call succeeds via the fallback");

  l = await launch({ g: HDR + "Name=Ghost\nExec=/nonexistent/ghost --x\n" }, "Ghost", [...BASE_TOOLS, "gio"]);
  eq(argvs(l), [["gio", "launch", l.dd.file("g")]], "an Exec binary that does not exist never spawns; gio takes over");

  // No gio: the next present tier.
  const dn = { n: HDR + "Name=Dbus Bare\nDBusActivatable=true\n" };
  l = await launch(dn, "Dbus Bare", [...BASE_TOOLS, "gtk-launch"]);
  eq(argvs(l), [["gtk-launch", "n"]], "no gio on PATH -> gtk-launch <desktop-id>");
  l = await launch(dn, "Dbus Bare", [...BASE_TOOLS, "kioclient5"]);
  eq(argvs(l), [["kioclient5", "exec", l.dd.file("n")]], "no gio/gtk-launch -> kioclient5 exec <file>");
  l = await launch(dn, "Dbus Bare", [...BASE_TOOLS, "kioclient6", "kioclient5"]);
  eq(argvs(l), [["kioclient6", "exec", l.dd.file("n")]], "kioclient6 is preferred over kioclient5");
  l = await launch(dn, "Dbus Bare", [...BASE_TOOLS, "exo-open"]);
  eq(argvs(l), [["exo-open", l.dd.file("n")]], "then exo-open <file>");
  l = await launch(dn, "Dbus Bare", [...BASE_TOOLS, "gio", "gtk-launch"], (cmd) => (cmd === "gio" ? { exit: 1 } : null));
  eq(argvs(l), [["gio", "launch", l.dd.file("n")], ["gtk-launch", "n"]], "a tool that exits non-zero hands over to the next tier");

  l = await launch(dn, "Dbus Bare", BASE_TOOLS);
  eq(argvs(l), [], "every launcher tool absent: nothing is spawned");
  ok(l.err && /Could not launch Dbus Bare/.test(l.err.message) && /no desktop launcher tool found/.test(l.err.message),
    "and the call fails with a clear error: " + (l.err && l.err.message));
  ok(!l.spawn.some((c) => c.argv.includes("xdg-open")), "no xdg-open <name> fallback any more");

  // All tiers fail (present but erroring).
  l = await launch(dn, "Dbus Bare", [...BASE_TOOLS, "gio"], (cmd) => (cmd === "gio" ? { error: true } : null));
  ok(l.err && /Could not launch Dbus Bare/.test(l.err.message) && /gio/.test(l.err.message), "all tiers failing reports the reason: " + (l.err && l.err.message));
}

async function testSetsidMissing() {
  console.log("\n[4] setsid missing: argv0 spawned directly, detached");
  const tools = BASE_TOOLS.filter((t) => t !== "setsid");
  const l = await launch({ a: HDR + 'Name=NoSetsid\nPath=/tmp\nExec=plain --a "b c"\n' }, "NoSetsid", tools);
  eq(argvs(l), [["plain", "--a", "b c"]], "argv0 itself is spawned");
  eq(l.spawn[0].opts, { detached: true, stdio: "ignore", cwd: "/tmp" }, "with detached:true (and the Path cwd)");
}

async function testPathUrl() {
  console.log("\n[5] path/URL inputs keep the xdg-open path");
  const l = await launch({}, "https://example.org/x", BASE_TOOLS);
  eq(argvs(l), [["setsid", "xdg-open", "https://example.org/x"]], "URL -> setsid xdg-open <url>");
  eq(l.spawn[0].opts, DEFAULT_OPTS, "options");
  ok(l.res && l.res.action === "opened", "returns opened");
}

async function testTryExec() {
  console.log("\n[6] TryExec: an unresolvable one hides the entry");
  await withApps({
    gone: HDR + "Name=Gone App\nTryExec=definitely-not-installed-xyz\nExec=@BIN@/plain\n",
    goneabs: HDR + "Name=Gone Abs\nTryExec=/nonexistent/bin/x\nExec=@BIN@/plain\n",
    here: HDR + "Name=Here App\nTryExec=plain\nExec=@BIN@/plain --here\n",
    hereabs: HDR + "Name=Here Abs\nTryExec=@BIN@/plain\nExec=@BIN@/plain --abs\n"
  }, BASE_TOOLS, async (r) => {
    const names = new Set((await r.ex.listInstalledApps()).map((a) => a.displayName));
    ok(!names.has("Gone App") && !names.has("Gone Abs"), "failing TryExec entries are not listed");
    ok(names.has("Here App") && names.has("Here Abs"), "TryExec found on PATH / as an absolute executable is listed");
    const res = await r.ex.openApp("Gone App");
    ok(res && res.action === "not_found", "openApp reports not_found for the skipped entry: " + J(res));
    ok(r.calls.spawn.length === 0, "and spawns nothing");
  });
}

async function testResolveOrder() {
  console.log("\n[7] _resolveApp: name / desktop-id first, exec basename second");
  const l = await launch({
    "a-brave-webapp": HDR + "Name=Brave Web App\nExec=@BIN@/brave --app=https://web.example/\n",
    "brave-browser": HDR + "Name=Brave\nExec=@BIN@/brave %U\n"
  }, "brave", BASE_TOOLS);
  eq(argvs(l), [["setsid", path.join(l.bin, "brave")]], "two entries share the exec basename: the one NAMED brave wins (the web app sorts first)");
  const l2 = await launch({
    "a-brave-webapp": HDR + "Name=Brave Web App\nExec=@BIN@/brave --app=https://web.example/\n"
  }, "brave", BASE_TOOLS);
  eq(argvs(l2), [["setsid", path.join(l2.bin, "brave"), "--app=https://web.example/"]], "with no better match the exec basename still resolves");
  const l3 = await launch({ "org.x.Thing": HDR + "Name=Thing\nExec=plain\n" }, "org.x.thing", BASE_TOOLS);
  eq(argvs(l3), [["setsid", "plain"]], "desktop-file id matches case-insensitively");
}

async function testListNoWrappers() {
  console.log("\n[8] listInstalledApps: desktop-file id, real argv0 alias, no wrapper names");
  await withApps({
    "org.gnome.Calculator": HDR + "Name=Calculator\nIcon=org.gnome.Calculator\nExec=flatpak run --branch=stable --arch=x86_64 --command=gnome-calculator org.gnome.Calculator @@u %U @@\n",
    "firefox_firefox": HDR + "Name=Firefox Web Browser\nExec=env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop @OPT@/snapbin/firefox %u\n",
    "envq": HDR + 'Name=Quoted Thing\nExec=env FOO=bar -u BAZ "@OPT@/My App/run" %U\n',
    "shwrap": HDR + "Name=Shell Wrapped\nExec=sh -c \"exec shapp\"\n",
    "gtkl": HDR + "Name=Via GtkLaunch\nExec=gtk-launch something\n",
    "snaprun": HDR + "Name=Snap Run\nExec=snap run foo\n",
    "dbus": HDR + "Name=Dbus Bare\nDBusActivatable=true\n"
  }, BASE_TOOLS, async (r) => {
    const apps = await r.ex.listInstalledApps();
    const ids = apps.map((a) => a.bundleId);
    const WRAP = ["env", "flatpak", "sh", "bash", "gio", "gtk-launch", "snap", "xdg-open"];
    ok(!ids.some((i) => WRAP.includes(i)), "no wrapper name is a bundleId: " + J([...new Set(ids)]));
    ok(!apps.some((a) => WRAP.includes(a.displayName)), "no wrapper name is an alias row either");
    const find = (id, dn) => apps.find((a) => a.bundleId === id && a.displayName === dn);
    ok(find("org.gnome.Calculator", "Calculator"), "flatpak run ... <app.id> -> bundleId is the app id");
    ok(find("firefox_firefox", "Firefox Web Browser"), "Snap env BAMF ... firefox -> bundleId firefox_firefox (the desktop-file id)");
    ok(find("firefox_firefox", "firefox"), "and its real argv0 firefox is an alias row of the same id");
    const ffRows = apps.filter((a) => a.bundleId === "firefox_firefox");
    ok(ffRows[ffRows.length - 1].displayName === "Firefox Web Browser", "the Name row comes last (upstream's maps keep the last row): " + J(ffRows));
    ok(find("envq", "Quoted Thing") && find("envq", "run"), "env FOO=bar -u BAZ \"/opt/My App/run\" -> bundleId envq, alias row run");
    ok(find("shwrap", "Shell Wrapped") && find("gtkl", "Via GtkLaunch") && find("snaprun", "Snap Run"),
      "sh/gtk-launch/snap wrappers fall back to the desktop-file id");
    ok(find("dbus", "Dbus Bare"), "a D-Bus activatable entry without Exec is listed under its desktop-file id");
  });
}

async function testDirs() {
  console.log("\n[9] entry dirs: snap, NixOS system + per-user, nix-env, user flatpak, XDG_DATA_DIRS");
  const r = load({ PATH: makeBin([]), XDG_DATA_HOME: path.join(TMP, "dh"), XDG_DATA_DIRS: "/usr/local/share:/usr/share:/custom/share" });
  try {
    await r.ex.listInstalledApps();
    const dirs = r.calls.readdir.filter((d) => /applications\/?$/.test(d));
    for (const want of [
      "/var/lib/snapd/desktop/applications", "/run/current-system/sw/share/applications",
      "/etc/profiles/per-user/tester/share/applications", path.join(HOME, ".nix-profile/share/applications"),
      path.join(HOME, ".local/share/flatpak/exports/share/applications"), "/var/lib/flatpak/exports/share/applications",
      "/custom/share/applications", "/usr/share/applications"]) {
      ok(dirs.includes(want), "searched: " + want);
    }
    ok(dirs[0] === path.join(TMP, "dh", "applications"), "XDG_DATA_HOME stays first");
    ok(new Set(dirs).size === dirs.length, "no dir is read twice");
  } finally { r.restore(); }
}

async function testReviewFixes() {
  console.log("\n[10] review fixes: BOM, lenient backslash, prototype names, $TERMINAL, uncached pre-check, bad Path=");

  // A: a UTF-8 BOM before [Desktop Entry] must not hide the entry.
  let l = await launch({ bom: "\uFEFF" + HDR + "Name=Bom App\nExec=plain --bom\n" }, "Bom App", BASE_TOOLS);
  eq(argvs(l), [["setsid", "plain", "--bom"]], "A: an entry starting with a UTF-8 BOM is parsed and launched");

  // B: an unquoted backslash escapes the next character (g_shell_parse_argv).
  l = await launch({ wine: HDR + String.raw`Name=Wine Prog
Exec=plain C:\\\\windows\\\\command\\\\start.exe
` }, "Wine Prog", BASE_TOOLS);
  eq(argvs(l), [["setsid", "plain", String.raw`C:\windows\command\start.exe`]], "B: Wine Exec with doubled backslashes survives both passes as C:\\windows\\command\\start.exe");
  l = await launch({ sp: HDR + String.raw`Name=Space Esc
Exec=@OPT@/My\ App/run --x
` }, "Space Esc", BASE_TOOLS);
  eq(argvs(l), [["setsid", path.join(OPT, "My App", "run"), "--x"]], "B: an escaped space keeps /opt/My\\ App/run as one argument");
  l = await launch({ tb: HDR + "Name=Trail Bs\nExec=plain abc\\\n" }, "Trail Bs", [...BASE_TOOLS, "gio"]);
  eq(argvs(l), [["gio", "launch", l.dd.file("tb")]], "B: a trailing lone backslash is still malformed");

  // C: prototype property names are not wrappers.
  await withApps({
    ts: HDR + "Name=ToString App\nExec=toString --x\n",
    ct: HDR + "Name=Ctor App\nExec=flatpak run --command=x constructor\n"
  }, BASE_TOOLS, async (r) => {
    const apps = await r.ex.listInstalledApps();
    ok(apps.some((a) => a.bundleId === "ts" && a.displayName === "toString"), "C: argv0 `toString` is a plain name (an alias row of ts), not a wrapper");
    ok(apps.some((a) => a.bundleId === "ct" && a.displayName === "Ctor App"), "C: `flatpak run --command=x constructor` (no dot) falls back to the desktop-file id");
    ok(!apps.some((a) => a.bundleId === "constructor"), "C: `constructor` never becomes a bundleId");
  });

  // D: $TERMINAL with arguments is split into argv; an unusable one is logged and reported.
  const term = { t: HDR + "Name=Term App\nTerminal=true\nExec=@BIN@/htop --x\n" };
  {
    const bin = makeBin([...BASE_TOOLS, "myterm"]);
    const dd = dataDir(term, bin);
    const r = load({ PATH: bin, XDG_DATA_HOME: dd.data, TERMINAL: "myterm --single --flag" });
    try { await r.ex.openApp("Term App"); eq(r.calls.spawn.map((c) => c.argv), [["myterm", "--single", "--flag", "-e", path.join(bin, "htop"), "--x"]], "D: TERMINAL=\"myterm --single --flag\" -> argv split, then -e + argv"); }
    finally { r.restore(); }
  }
  {
    const bin = makeBin(BASE_TOOLS);
    const dd = dataDir(term, bin);
    const r = load({ PATH: bin, XDG_DATA_HOME: dd.data, TERMINAL: "no-such-term --y" });
    try {
      let err; try { await r.ex.openApp("Term App"); } catch (e) { err = e; }
      ok(err && /\$TERMINAL \(no-such-term --y\): no-such-term not found/.test(err.message), "D: the error reasons name the unusable $TERMINAL: " + (err && err.message));
      ok(r.diag.some((d) => d.includes("$TERMINAL (no-such-term --y)")), "D: and one diag line logs it");
    } finally { r.restore(); }
  }

  // E: the launch pre-check is not negatively cached for the process lifetime.
  {
    const bin = makeBin(["setsid", "gio"]);
    const dd = dataDir({ late: HDR + "Name=Late App\nExec=late-app --x\n" }, bin);
    const r = load({ PATH: bin, XDG_DATA_HOME: dd.data });
    try {
      await r.ex.openApp("Late App");
      eq(r.calls.spawn.map((c) => c.argv), [["gio", "launch", dd.file("late")]], "E: before install the missing binary falls to gio");
      r.calls.spawn.length = 0;
      exe(path.join(bin, "late-app"));
      await r.ex.openApp("Late App");
      eq(r.calls.spawn.map((c) => c.argv), [["setsid", "late-app", "--x"]], "E: after the app is installed it launches directly, no restart");
    } finally { r.restore(); }
  }

  // G: a TryExec binary installed mid-session un-hides the entry (no negative cache).
  {
    const bin = makeBin(["setsid", "plain"]);
    const dd = dataDir({ tx: HDR + "Name=Tx App\nTryExec=late-tool\nExec=@BIN@/plain --tx\n" }, bin);
    const r = load({ PATH: bin, XDG_DATA_HOME: dd.data });
    try {
      const before = await r.ex.listInstalledApps();
      ok(!before.some((a) => a.displayName === "Tx App"), "G: missing TryExec hides the entry on the first listing");
      exe(path.join(bin, "late-tool"));
      const after = await r.ex.listInstalledApps();
      ok(after.some((a) => a.displayName === "Tx App"), "G: after TryExec is installed the entry is listed, no restart");
      await r.ex.openApp("Tx App");
      eq(r.calls.spawn.map((c) => c.argv), [["setsid", path.join(bin, "plain"), "--tx"]], "G: and it launches");
    } finally { r.restore(); }
  }

  // F: an unusable Path= is reported as such and skips the direct launch.
  l = await launch({ bp: HDR + "Name=Bad Path\nPath=/nonexistent/workdir\nExec=plain\n" }, "Bad Path", [...BASE_TOOLS, "gio"]);
  eq(argvs(l), [["gio", "launch", l.dd.file("bp")]], "F: a missing Path= dir skips the direct spawn and falls to gio");
  l = await launch({ bp: HDR + "Name=Bad Path\nPath=/nonexistent/workdir\nExec=plain\n" }, "Bad Path", BASE_TOOLS);
  ok(l.err && /working directory \/nonexistent\/workdir not usable/.test(l.err.message) && !/ENOENT/.test(l.err.message),
    "F: with no launcher tool the error says the working directory is not usable: " + (l.err && l.err.message));
}

// Upstream (v4.23118) narrows PATH to system dirs and keeps the started PATH in
// CLAUDE_DESKTOP_STARTED_PATH. On the desktop the app's bare Exec= is looked up
// on, and spawned with, the started PATH (APP PATH); setsid and the launcher
// tools are ours: taken from the narrowed dirs (TOOL PATH) and spawned by
// absolute path, never from a user-writable dir on the started PATH - here a
// temp dir, owned by us. The launcher tool gets the APP PATH in its env: it
// resolves Exec= itself.
async function testStartedPath() {
  console.log("\n[S] desktop mode under upstream's PATH narrowing");
  const sys = makeBin(["setsid", "gio"]);
  const user = makeBin(["setsid", "gio", "cdbapp"]);
  const dd = dataDir({ app: HDR + "Name=Probe App\nExec=cdbapp --x %U\n", dbus: HDR + "Name=Bus Only\nDBusActivatable=true\n", gone: HDR + "Name=Gone App\nExec=gone-app\n" }, sys);
  const env = { PATH: sys, CLAUDE_DESKTOP_NARROWED_PATH: sys, CLAUDE_DESKTOP_STARTED_PATH: user + ":rel:" + sys, XDG_DATA_HOME: dd.data };
  const APP = user + ":" + sys;
  const r = load(env);
  try {
    await r.ex.openApp("Probe App");
    eq(r.calls.spawn.map((c) => [c.argv, c.opts.env && c.opts.env.PATH]), [[[path.join(sys, "setsid"), "cdbapp", "--x"], APP]],
      "S: per-user app: /<narrowed>/setsid by absolute path, the app found on and spawned with the APP PATH");
    ok(r.diag.some((d) => d === "[claude-cu] openApp: cdbapp -> " + path.join(user, "cdbapp") + " (found on the PATH Claude Desktop was started with, not on the narrowed one)"), "S: one line names the started PATH");
    r.calls.spawn.length = 0;
    await r.ex.openApp("Bus Only");
    eq(r.calls.spawn.map((c) => [c.argv, c.opts.env && c.opts.env.PATH]), [[[path.join(sys, "gio"), "launch", dd.file("dbus")], APP]],
      "S: no Exec -> gio from the narrowed dir, with the APP PATH in its env");
    r.calls.spawn.length = 0;
    await r.ex.openApp("Gone App");
    eq(r.calls.spawn.map((c) => c.argv[0]), [path.join(sys, "gio")], "S: an app on neither PATH falls to gio (system copy)");
    ok(process.env.PATH === sys, "S: process.env.PATH untouched");
  } finally { r.restore(); }
  // Without a system setsid the planted one is still not used: the app is
  // spawned directly (APP PATH in its env).
  const sys2 = makeBin(["gio"]);
  const r2 = load({ ...env, PATH: sys2, CLAUDE_DESKTOP_NARROWED_PATH: sys2, CLAUDE_DESKTOP_STARTED_PATH: user + ":" + sys2 });
  try {
    await r2.ex.openApp("Probe App");
    eq(r2.calls.spawn.map((c) => [c.argv, c.opts.env && c.opts.env.PATH]), [[["cdbapp", "--x"], user + ":" + sys2]],
      "S: setsid only in a user-writable dir: ignored, the app spawned directly");
    ok(r2.diag.some((d) => d.includes("tools: setsid found only in " + user + ", a user-writable folder - ignored")), "S: the ignored copy is logged");
  } finally { r2.restore(); }
}

async function main() {
  try {
    await testArgvShapes();
    await testDbus();
    await testFallbackChain();
    await testSetsidMissing();
    await testPathUrl();
    await testTryExec();
    await testResolveOrder();
    await testListNoWrappers();
    await testDirs();
    await testReviewFixes();
    await testStartedPath();
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
