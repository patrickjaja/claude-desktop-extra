#!/usr/bin/env node
// `claude-desktop --diagnose`: does it probe the host the way the APP does?
//
// WHY THIS EXISTS
// ---------------
// --diagnose is what an issue reporter pastes. It is only useful when each
// line answers the question the app itself asks:
//
//   - The app runs /usr/bin/{busctl,secret-tool,kwallet-query} by
//     literal path, and our patches fall back to PATH when the file is not
//     there. "command -v busctl" is not that question: a NixOS host has busctl
//     on PATH only, and a host with /usr/bin/busctl may have a different one
//     first on PATH. Each tool must come out as upstream path / PATH only
//     (works through our fallback) / MISSING, with what breaks.
//   - The GlobalShortcuts portal verdict that gates every Wayland hotkey comes
//     from one exact busctl invocation. A gdbus probe can say yes while the
//     app's busctl probe says no; only the app's verdict counts.
//   - A bridge that is present but cannot run (foreign ELF loader, glibc or
//     PipeWire too old) is exactly what js/cu_mode_preamble.js skips; the
//     report must say the same thing with the same hint.
//   - The launcher normalizes XDG_SESSION_TYPE before --diagnose runs, so the
//     raw value has to be kept or the report hides the mismatch it fixed.
//
// This harness extracts the real helper functions from the launcher and runs
// them against fake tools, then drives the real launcher's --diagnose in a
// fake install tree. It never starts Electron.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync,
         existsSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const launcherPath = join(repo, "scripts", "claude-desktop-launcher.sh");
const launcherSrc = readFileSync(launcherPath, "utf8");

const BASH = (spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout || "").trim();
const TIMEOUT = (spawnSync("sh", ["-c", "command -v timeout"], { encoding: "utf8" }).stdout || "").trim();
if (!BASH || !TIMEOUT) {
  console.log("SKIP: bash or coreutils timeout not found");
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
function safe(label, f) {
  try { f(); } catch (e) {
    console.log(`  FAIL ${label} -> threw: ${e.message}`);
    failures.push(label);
  }
}

function fn(name) {
  const re = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m");
  const m = launcherSrc.match(re);
  if (!m) throw new Error(`launcher function ${name}() not found`);
  return m[0];
}

const scratch = join(tmpdir(), `cdb-launcher-diag-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

function writeExe(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Coreutils the helpers need, linked into a PATH dir that holds nothing else,
// so a case controls exactly which host tools exist.
const coreBin = join(scratch, "core");
mkdirSync(coreBin, { recursive: true });
for (const t of ["timeout", "head", "sed", "uname", "tr", "od", "cat", "sleep", "printf", "stat", "readlink"]) {
  const p = (spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout || "").trim();
  if (p.startsWith("/")) writeExe(join(coreBin, t), `#!/bin/sh\nexec ${p} "$@"\n`);
}

function runFns(fnNames, script, env) {
  const prelude = ["set -euo pipefail", ...fnNames.map(fn)].join("\n");
  const r = spawnSync(BASH, ["-c", `${prelude}\n${script}`], { env, encoding: "utf8" });
  return { out: (r.stdout || "").trim(), err: r.stderr || "", status: r.status };
}

// ---------------------------------------------------------------- D1
console.log("D1: host tool lines say where the app finds each tool");
safe("D1", () => {
  const root = join(scratch, "d1");
  const abs = join(root, "usr", "bin");
  const onPath = join(root, "path");
  writeExe(join(abs, "busctl"), "#!/bin/sh\n");
  writeExe(join(onPath, "busctl"), "#!/bin/sh\n");
  writeExe(join(onPath, "gjs"), "#!/bin/sh\n");
  // _DIAG_NARROWED stands in for upstream's narrowed PATH (scratch dirs
  // cannot be root-owned): onPath plays a system folder the app searches.
  const env = { PATH: `${onPath}:${coreBin}`, _DIAG_NARROWED: onPath };
  const TP_FNS = ["_diag_trust_rule", "_diag_chain_real", "_diag_narrowed_path", "_diag_tool_path", "_diag_which_in", "_diag_cap"];
  const cap = (args, e = env) => runFns(TP_FNS,
    `_diag_problems=(); _diag_cap ${args}; printf 'P=%s\\n' "\${_diag_problems[@]:-}"`, e).out;
  const up = cap(`fallback busctl ${abs}/busctl 1 'portal probe' 'hotkeys off'`);
  check("upstream path wins", /^\[ok\] +busctl = .*usr\/bin\/busctl \(upstream path\)/.test(up), true);
  const fb = cap(`fallback busctl ${root}/none/busctl 1 'portal probe' 'hotkeys off'`);
  check("found in a folder the app searches is reported as our fallback",
    fb.includes(`busctl = ${onPath}/busctl (not at ${root}/none/busctl; found by our fallback in a system or root-owned read-only folder)`), true);
  check("found by the fallback is not a problem", fb.endsWith("P="), true);
  // Since 4.23118 the app ignores a copy in a folder the user can write
  // (upstream narrows PATH; our resolver adds only root-owned read-only dirs).
  const userEnv = { PATH: `${onPath}:${coreBin}`, _DIAG_NARROWED: `${root}/nothing-here` };
  const ign = cap(`fallback busctl ${root}/none/busctl 1 'portal probe' 'hotkeys off'`, userEnv);
  check("a copy only in a user-writable folder is MISSING, and named",
    ign.includes(`[MISS] busctl = MISSING - hotkeys off (found ${onPath}/busctl, a user-writable folder the app does not run its own tools from - install busctl system-wide)`), true);
  // A real root-owned, read-only folder outside the narrowed list, when the
  // host has one: the trust walk takes it.
  const trustedDir = ["/usr/lib/systemd", "/usr/libexec", "/usr/lib/git-core"].find((d) => {
    try { return lstatSync(d).isDirectory() && lstatSync(d).uid === 0 && readdirSync(d).some((f) => { try { const st = lstatSync(join(d, f)); return st.isFile() && (st.mode & 0o111) && /^[a-z][a-z0-9_-]+$/.test(f); } catch { return false; } }); } catch { return false; }
  });
  if (trustedDir && process.getuid() !== 0) {
    const exe = readdirSync(trustedDir).sort().find((f) => { try { const st = lstatSync(join(trustedDir, f)); return st.isFile() && (st.mode & 0o111) && /^[a-z][a-z0-9_-]+$/.test(f); } catch { return false; } });
    const tr = cap(`fallback ${exe} ${root}/none/${exe} 1 'x' 'y'`, { PATH: `${trustedDir}:${coreBin}`, _DIAG_NARROWED: `${root}/nothing-here` });
    check(`a root-owned read-only started-PATH folder (${trustedDir}) is searched`,
      tr.includes(`${exe} = ${trustedDir}/${exe} (not at`), true);
    const ln = join(root, "user-link");
    spawnSync("ln", ["-s", trustedDir, ln]);
    const tl = cap(`fallback ${exe} ${root}/none/${exe} 1 'x' 'y'`, { PATH: `${ln}:${coreBin}`, _DIAG_NARROWED: `${root}/nothing-here` });
    check("the same folder through a user-owned symlink is not", tl.startsWith(`[MISS] ${exe} = MISSING`), true);
  } else {
    console.log("  (no root-owned read-only folder with a tool on this host: trusted-folder case skipped)");
  }
  // A PATH entry with glob characters is one literal entry (the app never
  // globs): /tmp/x/g* must not expand to /tmp/x/ga.
  writeExe(join(root, "ga", "globtool"), "#!/bin/sh\n");
  const g = runFns(TP_FNS, `_diag_which_in globtool '${root}/g*' || echo none; _diag_tool_path '${root}/g*:/nonexistent' '${onPath}'`, env).out;
  check("glob entry: not expanded by _diag_which_in or _diag_tool_path", g, `none\n${onPath}`);
  // tool mode (xdg-open: our openExternal hook widens the call to the TOOL PATH).
  const toolOk = cap(`tool busctl '' 1 'links' 'links do nothing'`);
  check("tool mode: found in a folder the app searches", toolOk.startsWith(`[ok]   busctl = ${onPath}/busctl - links`), true);
  const toolMiss = cap(`tool busctl '' 1 'links' 'links do nothing'`, userEnv);
  check("tool mode: a user-writable copy is MISSING, and named",
    toolMiss.startsWith("[MISS] busctl = MISSING - links do nothing (found ") && toolMiss.includes("a user-writable folder the app does not run its own tools from"), true);
  const miss = cap(`fallback secret-tool ${abs}/secret-tool 1 'cookie import' 'cookies skipped'`);
  check("missing + needed is MISSING", /^\[MISS\] secret-tool = MISSING - cookies skipped/.test(miss), true);
  check("missing + needed is a problem", miss.includes("P=secret-tool missing: cookies skipped"), true);
  const notNeeded = cap(`fallback kwallet-query ${abs}/kwallet-query 0 'kwallet cookies' 'x'`);
  check("missing + not needed is informational", /^\[--\] +kwallet-query = missing, not needed/.test(notNeeded), true);
  check("missing + not needed is no problem", notNeeded.endsWith("P="), true);
  const absOnly = cap(`abs gjs ${abs}/gjs 1 'search provider' 'no search'`);
  check("literal-only tool on PATH is still MISSING",
    absOnly.includes(`[MISS] gjs = MISSING - no search (found ${onPath}/gjs, but only ${abs}/gjs is used)`), true);
  check("app resolves the literal path when it exists",
    runFns(["_diag_app_tool_cmd"], `_diag_app_tool_cmd ${abs}/busctl busctl`, env).out, `${abs}/busctl`);
  check("app falls back to the bare name",
    runFns(["_diag_app_tool_cmd"], `_diag_app_tool_cmd ${abs}/nope busctl`, env).out, "busctl");
});

// ---------------------------------------------------------------- D2
console.log("D2: portal probe is the app's exact busctl call");
// What upstream 2.19675.1 runs (the fixed prefix of its busctl helper plus the
// get-property argument list of its generic portal-version helper, called with
// "GlobalShortcuts").
const APP_ARGV = ["--user", "--timeout=2", "get-property", "org.freedesktop.portal.Desktop",
  "/org/freedesktop/portal/desktop", "org.freedesktop.portal.GlobalShortcuts", "version"];
safe("D2", () => {
  const root = join(scratch, "d2");
  const argFile = join(root, "argv");
  const fake = (name, body) => {
    const p = join(root, name);
    writeExe(p, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${argFile}\n${body}\n`);
    return p;
  };
  const env = { PATH: coreBin };
  const probe = (bin) => runFns(["_diag_portal_probe_app"], `_diag_portal_probe_app ${bin}`, env).out;
  check("answering portal -> yes + version", probe(fake("ok", "echo 'u 1'")), "yes 1");
  check("argv is the app's, argument for argument",
    readFileSync(argFile, "utf8").trim().split("\n").join(" "), APP_ARGV.join(" "));
  check("error reply -> no + first line",
    probe(fake("err", "echo 'No such interface' >&2; exit 1")), "no (No such interface)");
  check("version 0 is no, as the app's >0 test",
    probe(fake("zero", "echo 'u 0'")), "no (portal reports version 0)");
  check("output without a u-typed version is no",
    probe(fake("junk", "echo 's \"1\"'")).startsWith("no"), true);
  check("missing busctl -> cannot exec", probe(join(root, "absent")), `no (cannot exec ${join(root, "absent")})`);
  const t0 = Date.now();
  check("hang -> no answer within 3 s", probe(fake("hang", "sleep 6")), "no (no answer within 3 s)");
  check("hang is bounded by the app's 3 s", Date.now() - t0 < 5000, true);
  // Cross-check against the pristine bundle when one is extracted locally.
  const build = join(process.env.CDB_BUNDLE_DIR || join(repo, "tmp", "app.asar.contents"), ".vite", "build");
  if (existsSync(build)) {
    const text = readdirSync(build).filter((f) => /^index.*\.js$/.test(f))
      .map((f) => readFileSync(join(build, f), "latin1")).join("\n");
    const prefix = /["`]\/usr\/bin\/busctl["`],\[["`]--user["`],["`]--timeout=2["`],\.\.\.[\w$]+\]/.test(text);
    const q = (s) => `["\`]${s.replace(/[.\/]/g, "\\$&")}["\`]`;
    // The interface is a template over the helper's parameter; the helper must
    // also be called with "GlobalShortcuts".
    const [gp, dest, obj, iface, prop] = APP_ARGV.slice(2);
    const helper = new RegExp(`function ([\\w$]+)\\(([\\w$]+)\\)\\{try\\{let [\\w$]+=await [\\w$]+\\(\\[`
      + [gp, dest, obj].map(q).join(",")
      + `,\`${iface.replace(/GlobalShortcuts$/, "").replace(/\./g, "\\.")}\\$\\{\\2\\}\`,${q(prop)}\\]\\)`).exec(text);
    const called = !!helper && new RegExp(`(?<![\\w$])${helper[1].replace(/\$/g, "\\$")}\\(["\`]GlobalShortcuts["\`]\\)`).test(text);
    check("bundle: busctl helper prefix unchanged", prefix, true);
    check("bundle: GlobalShortcuts get-property argv unchanged", called, true);
  } else {
    console.log("  NOTE no extracted bundle; argv pinned to upstream 2.19675.1 only");
  }
});

// ---------------------------------------------------------------- D3
console.log("D3: bridges must run, with the preamble's causes and hints");
safe("D3", () => {
  const root = join(scratch, "d3");
  const env = { PATH: coreBin };
  const runs = (bin) => runFns(["_diag_elf_foreign", "_diag_bridge_runs"], `_diag_bridge_runs ${bin} X11_BRIDGE_BIN`, env).out;
  writeExe(join(root, "ok"), "#!/bin/sh\necho 'x11-bridge 0.1.0'\n");
  check("working bridge", runs(join(root, "ok")), "ok x11-bridge 0.1.0");
  writeExe(join(root, "glibc"), "#!/bin/sh\necho \"./b: /lib/libc.so.6: version \\`GLIBC_2.39' not found\" >&2\nexit 1\n");
  check("old glibc names the floor", /needs glibc >= 2\.39/.test(runs(join(root, "glibc"))), true);
  writeExe(join(root, "pw"), "#!/bin/sh\necho 'symbol lookup error: ./b: undefined symbol: pw_stream_get_nsec' >&2\nexit 127\n");
  check("old PipeWire names PipeWire", /needs PipeWire >= 1\.0\.5/.test(runs(join(root, "pw"))), true);
  writeExe(join(root, "lib"), "#!/bin/sh\necho './b: error while loading shared libraries: libfoo.so.1: cannot open shared object file' >&2\nexit 127\n");
  check("missing library is named", /missing shared library libfoo\.so\.1/.test(runs(join(root, "lib"))), true);
  // A missing interpreter makes the kernel return ENOENT, like a foreign ELF loader.
  writeExe(join(root, "interp"), "#!/nonexistent/ld-linux.so.2\n");
  const interp = runs(join(root, "interp"));
  check("foreign loader -> ENOENT cause", /ENOENT although the file exists/.test(interp), true);
  check("foreign loader hint names the override", /set X11_BRIDGE_BIN/.test(interp), true);
  writeExe(join(root, "arch"), "\x7fELF\x02\x01\x01garbage-not-a-real-elf");
  check("wrong architecture -> exec format error", /^FAIL exec format error/.test(runs(join(root, "arch"))), true);
  writeExe(join(root, "hang"), "#!/bin/sh\nsleep 10\n");
  const t0 = Date.now();
  check("hanging bridge", /^FAIL no answer to --version within 3 s/.test(runs(join(root, "hang"))), true);
  check("hang is bounded", Date.now() - t0 < 6000, true);
});

// ---------------------------------------------------------------- D4
console.log("D4: the app's own Wayland test");
safe("D4", () => {
  const w = (env) => runFns(["_diag_app_is_wayland"], "_diag_app_is_wayland && echo y || echo n",
    { PATH: coreBin, ...env }).out;
  check("wayland", w({ XDG_SESSION_TYPE: "wayland" }), "y");
  check("x11 with WAYLAND_DISPLAY is not wayland", w({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "w" }), "n");
  check("unset type falls back to WAYLAND_DISPLAY", w({ WAYLAND_DISPLAY: "w" }), "y");
  check("nothing set", w({}), "n");
});

// ---------------------------------------------------------------- D5
console.log("D5: the real --diagnose in a fake install");
function fakeTree(dir, bridges) {
  writeExe(join(dir, "claude"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(dir, "version"), "44.4.3\n");
  mkdirSync(join(dir, "resources"), { recursive: true });
  writeFileSync(join(dir, "resources", "app.asar"), "asar");
  for (const [name, body] of Object.entries(bridges)) writeExe(join(dir, "resources", name), body);
  return join(dir, "claude");
}
safe("D5", () => {
  const root = join(scratch, "d5");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const ok = (n) => `#!/bin/sh\necho '${n} 0.1.0'\n`;
  const electron = fakeTree(join(root, "tree"), {
    "x11-bridge": ok("x11-bridge"),
    "wlroots-bridge": ok("wlroots-bridge"),
    "gnome-portal-bridge": "#!/bin/sh\necho \"./b: version \\`GLIBC_2.39' not found\" >&2\nexit 1\n",
    // kwin-portal-bridge left out: MISSING, but not used on a GNOME session.
  });
  const r = spawnSync(BASH, [launcherPath, "--diagnose"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: electron,
           XDG_RUNTIME_DIR: join(root, "run"), XDG_SESSION_TYPE: "tty",
           WAYLAND_DISPLAY: "wayland-9", XDG_CURRENT_DESKTOP: "GNOME" },
    encoding: "utf8", timeout: 90000,
  });
  const out = r.stdout || "";
  check("exit status", r.status, 0);
  if (r.status !== 0) console.log(out + (r.stderr || ""));
  check("raw session type is kept next to the normalized one",
    out.includes("XDG_SESSION_TYPE = wayland (as passed to the app; raw from the session: tty)"), true);
  check("host capabilities section", out.includes("--- Host capabilities"), true);
  check("every probed tool has a line",
    ["busctl", "secret-tool", "kwallet-query", "xdg-open", "gjs", "python3", "socat"]
      .every((t) => new RegExp(`^\\[(ok|MISS|--)\\] +${t} = `, "m").test(out)), true);
  check("tray host line", /^\[(ok|MISS|--|\?\?)\] +tray host = /m.test(out), true);
  check("all four bridges are run",
    ["x11-bridge", "wlroots-bridge", "gnome-portal-bridge", "kwin-portal-bridge"]
      .every((b) => out.includes(`${b} runs = `)), true);
  check("unrunnable session bridge is reported with its hint",
    /gnome-portal-bridge runs = CANNOT RUN - exit 1: .*needs glibc >= 2\.39.*\(used on this session\)/.test(out), true);
  const problems = out.slice(out.indexOf("--- Problems found ---"));
  check("problems list closes the report", out.trimEnd().endsWith(problems.trimEnd()) && problems.length > 0, true);
  check("unrunnable gnome bridge is a problem", /^- gnome-portal-bridge at .* cannot run/m.test(problems), true);
  check("unused missing kwin bridge is not a problem", problems.includes("kwin-portal-bridge"), false);
  // No session bus in this environment: the app's probe cannot answer, and on
  // a Wayland session that disables every global shortcut.
  check("portal probe failure is a problem on Wayland", /^- GlobalShortcuts portal probe fails/m.test(problems), true);
  // Fonts: the section is always there; with the host's fontconfig intact it
  // reports a sans-serif match and no font problem.
  check("fonts section", out.includes("--- Fonts (fontconfig, as the app sees it) ---"), true);
  check("FONTCONFIG_FILE reported unset", /^FONTCONFIG_FILE = \(unset\)$/m.test(out), true);
  check("no font problem with an intact fontconfig", /^- (FONTCONFIG_|fontconfig finds no fonts)/m.test(problems), false);
});

// ---------------------------------------------------------------- D5b
// A FONTCONFIG_FILE that points nowhere is what leaves the app without a
// single system font (#281, #282): --diagnose names the variable, and the
// launch path drops it for the app.
console.log("D5b: --diagnose with a FONTCONFIG_FILE that points nowhere");
safe("D5b", () => {
  const root = join(scratch, "d5b");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const electron = fakeTree(join(root, "tree"), {});
  const r = spawnSync(BASH, [launcherPath, "--diagnose"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: electron,
           XDG_RUNTIME_DIR: join(root, "run"), XDG_SESSION_TYPE: "wayland",
           WAYLAND_DISPLAY: "wayland-9", XDG_CURRENT_DESKTOP: "KDE",
           FONTCONFIG_FILE: "/nonexistent/claude-test/fonts.conf",
           FONTCONFIG_PATH: "/nonexistent/claude-test:/nonexistent/claude-test2" },
    encoding: "utf8", timeout: 90000,
  });
  const out = r.stdout || "";
  check("exit status", r.status, 0);
  check("missing FONTCONFIG_FILE is marked", out.includes("FONTCONFIG_FILE = /nonexistent/claude-test/fonts.conf (MISSING)"), true);
  check("FONTCONFIG_PATH without an existing dir is marked", out.includes("FONTCONFIG_PATH = /nonexistent/claude-test:/nonexistent/claude-test2 (MISSING)"), true);
  const problems = out.slice(out.indexOf("--- Problems found ---"));
  check("FONTCONFIG_FILE is a problem", /^- FONTCONFIG_FILE points to a missing path/m.test(problems), true);
  check("FONTCONFIG_PATH is a problem", /^- FONTCONFIG_PATH points to a missing path/m.test(problems), true);
  // The helper itself, as the launch path calls it: unusable values fail, an
  // existing path and a relative file name pass.
  const fns = runFns(["_fontconfig_var_usable"],
    `FONTCONFIG_FILE=/nonexistent/claude-test/fonts.conf; _fontconfig_var_usable FONTCONFIG_FILE && echo A=usable || echo A=unusable;` +
    `FONTCONFIG_FILE=/etc/fonts/fonts.conf; _fontconfig_var_usable FONTCONFIG_FILE && echo B=usable || echo B=unusable;` +
    `FONTCONFIG_FILE=local.conf; _fontconfig_var_usable FONTCONFIG_FILE && echo C=usable || echo C=unusable;` +
    `FONTCONFIG_PATH=/nonexistent/claude-test:/etc/fonts; _fontconfig_var_usable FONTCONFIG_PATH && echo D=usable || echo D=unusable;` +
    `unset FONTCONFIG_SYSROOT; _fontconfig_var_usable FONTCONFIG_SYSROOT && echo E=usable || echo E=unusable`, {}).out;
  check("helper: missing absolute file is unusable", fns.includes("A=unusable"), true);
  check("helper: existing file is usable", fns.includes("B=usable"), existsSync("/etc/fonts/fonts.conf"));
  check("helper: relative file name is left alone", fns.includes("C=usable"), true);
  check("helper: path list with one existing dir is usable", fns.includes("D=usable"), existsSync("/etc/fonts"));
  check("helper: unset variable is usable", fns.includes("E=usable"), true);

  // Colon lists are split without globbing: an entry with `*` is one literal path.
  const gl = join(scratch, "d5glob");
  mkdirSync(join(gl, "real"), { recursive: true });
  const globRun = (list) => runFns(["_fontconfig_var_usable"],
    `FONTCONFIG_PATH=${JSON.stringify(list)}; _fontconfig_var_usable FONTCONFIG_PATH && echo usable || echo unusable`,
    { PATH: "/usr/bin:/bin" }).out;
  check("helper: `*` entry is NOT glob-expanded onto a sibling dir", globRun(join(gl, "*")), "unusable");
  check("helper: `*` entry is unusable even after a missing entry", globRun(`/nonexistent/claude-test:${join(gl, "*")}`), "unusable");
  mkdirSync(join(gl, "*"), { recursive: true });
  check("helper: a directory literally named `*` is found", globRun(join(gl, "*")), "usable");
  check("helper: empty entries are skipped, real dir still found", globRun(`::${join(gl, "real")}:`), "usable");
});

// ---------------------------------------------------------------- D6
console.log("D6: --diagnose and --help change nothing on disk");
// Both are read-only reports. They used to run the per-profile binary refresh
// (up to a ~200 MB copy into ~/.local/lib) and the AppImage desktop
// integration before dispatching. The launcher's own log under
// $XDG_CACHE_HOME/claude-desktop is the one thing allowed to change.
function snapshot(dir, skip) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (p === skip) continue;
      const st = lstatSync(p);
      out[p] = e.isSymbolicLink() ? `l:${readlinkSync(p)}` : `${st.size}:${st.mtimeMs}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}
safe("D6 profile refresh", () => {
  const root = join(scratch, "d6");
  const home = join(root, "home");
  const treeA = fakeTree(join(root, "treeA"), {});
  const treeB = fakeTree(join(root, "treeB"), {});
  const libDir = join(home, ".local", "lib", "claude-desktop");
  mkdirSync(libDir, { recursive: true });
  // A profile made from tree A; the launcher now points at tree B, so a
  // launch would refresh it ("mirrors a different install").
  const setup = spawnSync(BASH, ["-c", [
    "set -euo pipefail", "APP_ID=claude", "log() { :; }",
    fn("_materialise_profile_binary"), fn("_mirror_profile_siblings"),
    `_materialise_profile_binary "${treeA}" "${libDir}/claude-work"`,
    `_mirror_profile_siblings "${dirname(treeA)}" "${libDir}" claude`,
  ].join("\n")], { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
  check("profile fixture created", setup.status, 0);
  const cache = join(home, ".cache");
  const before = snapshot(home, cache);
  for (const sub of ["--help", "--diagnose"]) {
    const r = spawnSync(BASH, [launcherPath, "--profile=work", sub], {
      env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: treeB,
             XDG_RUNTIME_DIR: join(root, "run"), DISPLAY: ":99" },
      encoding: "utf8", timeout: 90000,
    });
    check(`${sub} exit status`, r.status, 0);
    check(`${sub} leaves HOME untouched`, JSON.stringify(snapshot(home, cache)), JSON.stringify(before));
    check(`${sub} does not refresh the profile`, /Refreshing/.test(r.stderr || ""), false);
  }
  // A real launch still heals the profile (the fake Electron just exits 0).
  const launch = spawnSync(BASH, [launcherPath, "--profile=work"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: treeB,
           XDG_RUNTIME_DIR: join(root, "run"), DISPLAY: ":99", CLAUDE_KEEP_TTY: "1" },
    encoding: "utf8", timeout: 90000,
  });
  check("a launch exits with the fake Electron's status", launch.status, 0);
  check("a launch still refreshes the stale profile",
    readlinkSync(join(libDir, "resources")), join(dirname(treeB), "resources"));
});
safe("D6 rpm", () => {
  // Debian/Ubuntu hosts with the rpm tool but no rpm database get ~/.rpmdb on
  // the first query; every rpm -q in --diagnose must be gated on a real db.
  const q = launcherSrc.match(/^.*rpm -q .*$/gm) || [];
  check("--diagnose queries rpm", q.length > 0, true);
  check("every rpm -q is gated on _diag_has_rpmdb", q.every((l) => l.includes("_diag_has_rpmdb &&")), true);
});
safe("D6 ordering", () => {
  // The AppImage integration is skipped whenever a system .desktop exists,
  // so a behavioral test would pass on a machine that has the package
  // installed. Pin the order instead: both side effects sit after the
  // subcommand case (so --help and friends exit first) and are skipped when
  // --diagnose was requested (it is deferred past them).
  const at = (s) => launcherSrc.indexOf(s);
  const caseEnd = at("        _diagnose_requested=1\n        ;;\nesac\n");
  check("subcommand case end found", caseEnd > 0, true);
  const guard = (call) => {
    const i = at(`\n    ${call}\n`);
    const cond = launcherSrc.lastIndexOf("\nif [[", i);
    return i > caseEnd && launcherSrc.slice(cond, i).includes('-z "${_diagnose_requested:-}"');
  };
  check("profile refresh: after the case, skipped for --diagnose",
    guard("_refresh_profile_binary_if_stale || true"), true);
  check("AppImage integration: after the case, skipped for --diagnose",
    guard("_appimage_integrate quiet || true"), true);
});

// ---------------------------------------------------------------- D7
// --reset-screen-sharing runs each bundled portal bridge's forget-session and
// says what happened in words; only a bridge that failed fails the command.
// The bridges print one JSON object: GNOME on one line, KDE pretty-printed.
console.log("D7: --reset-screen-sharing");
safe("D7", () => {
  const root = join(scratch, "d7");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const reply = (json, code = 0) => `#!/bin/sh\n[ "$1" = --version ] && { echo 'b 0.1.0'; exit 0; }\n[ "$1" = forget-session ] || exit 9\ncat <<'EOF'\n${json}\nEOF\nexit ${code}\n`;
  const GNOME_OK = reply('{"ok":true,"ended":true,"daemon":"sigterm","token_removed":true,"token_path":"/s/gnome-portal-bridge/restore-token.json"}');
  const GNOME_NOTHING = reply('{"ok":true,"ended":true,"token_removed":false,"token_path":"/s/x"}');
  const KDE_NOTHING = reply('{\n  "daemon": "none",\n  "ended": false,\n  "ok": true,\n  "token_path": "/s/y",\n  "token_removed": false\n}');
  const KDE_FAIL = reply('{\n  "error": "failed to delete restore token /s/y: Is a directory (os error 21)",\n  "ok": false\n}', 1);
  const OLD = "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'b 0.1.0'; exit 0; }\necho \"error: unrecognized subcommand '$1'\" >&2\nexit 2\n";
  const run = (name, bridges, extraEnv = {}) => {
    const electron = fakeTree(join(root, name), bridges);
    const r = spawnSync(BASH, [launcherPath, "--reset-screen-sharing"], {
      env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: electron, XDG_RUNTIME_DIR: join(root, "run"), ...extraEnv },
      encoding: "utf8", timeout: 60000,
    });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  let r = run("both", { "gnome-portal-bridge": GNOME_OK, "kwin-portal-bridge": KDE_NOTHING });
  check("both bridges: exit 0", r.status, 0);
  check("GNOME line names the removed choice and the ended session",
    r.out.includes("GNOME screen sharing: remembered choice removed and the running screen-sharing session ended; the next Computer Use task will ask again."), true);
  check("KDE pretty-printed answer with nothing stored", r.out.includes("KDE screen sharing: nothing to reset."), true);
  check("GNOME without a daemon field ended nothing (ended:true is not trusted)",
    run("gnone", { "gnome-portal-bridge": GNOME_NOTHING }).out.includes("GNOME screen sharing: nothing to reset."), true);
  r = run("one", { "gnome-portal-bridge": GNOME_OK });
  check("one bridge missing: exit 0", r.status, 0);
  check("one bridge missing: only the present one reports", r.out.includes("GNOME screen sharing:") && !r.out.includes("KDE"), true);
  r = run("fail", { "gnome-portal-bridge": GNOME_OK, "kwin-portal-bridge": KDE_FAIL });
  check("ok:false: exit non-zero", r.status, 1);
  check("ok:false: the bridge's error is shown",
    r.out.includes("KDE screen sharing: reset FAILED - failed to delete restore token /s/y: Is a directory (os error 21)"), true);
  check("ok:false: the other bridge still ran", r.out.includes("GNOME screen sharing: remembered choice removed"), true);
  r = run("old", { "gnome-portal-bridge": OLD });
  check("older bridge without forget-session: exit 0", r.status, 0);
  check("older bridge without forget-session: said plainly",
    /GNOME screen sharing: this bridge cannot reset its remembered choice .*; update claude-desktop-extra\./.test(r.out), true);
  const oldOverride = join(root, "old-override");
  writeExe(oldOverride, OLD);
  r = run("old-ov", {}, { GNOME_PORTAL_BRIDGE_BIN: oldOverride });
  check("older bridge from an override: the variable is named, not the package",
    r.out.includes(`GNOME screen sharing: GNOME_PORTAL_BRIDGE_BIN points to a bridge without forget-session (${oldOverride}); update that bridge.`), true);
  r = run("none", {});
  check("no bridges: nothing to reset", /No Computer Use bridge with a screen-sharing session found in .*; nothing to reset\./.test(r.out) && r.status === 0, true);
  // The app's *_BRIDGE_BIN override wins over resources/, as in js/cu_mode_preamble.js.
  const override = join(root, "override-kwin");
  writeExe(override, KDE_FAIL);
  r = run("override", { "kwin-portal-bridge": KDE_NOTHING }, { KWIN_PORTAL_BRIDGE_BIN: override });
  check("KWIN_PORTAL_BRIDGE_BIN override is used", r.status === 1 && r.out.includes("reset FAILED"), true);
});

// ---------------------------------------------------------------- D8
console.log("D8: --diagnose with contract-0 portal bridges (the pre-contract checks)");
safe("D8", () => {
  const root = join(scratch, "d8");
  const home = join(root, "home");
  const state = join(root, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(state, "kwin-portal-bridge"), { recursive: true });
  writeFileSync(join(state, "kwin-portal-bridge", "restore-token.json"), "{}");
  // forget-session would delete the grant: --diagnose must never call it, and
  // session-start would open the portal: it must never be called either.
  const gnome = `#!/bin/sh
case "$1" in
  --version) echo 'gnome-portal-bridge 0.1.0' ;;
  doctor) echo '{"restore_token_present":true,"daemon_running":true}' ;;
  screens) echo '[{"id":"eDP-1","geometry":{"x":0,"y":0,"width":1,"height":1},"is_primary":true,"is_shared":true},{"id":"HDMI-1","geometry":{"x":1,"y":0,"width":1,"height":1},"is_primary":false,"is_shared":false}]' ;;
  forget-session) [ "$2" = --help ] && exit 0; echo "unexpected $*" >> "${root}/forbidden"; exit 1 ;;
  *) echo "unexpected $1" >> "${root}/forbidden"; exit 1 ;;
esac
`;
  const kwin = `#!/bin/sh
case "$1" in
  --version) echo 'kwin-portal-bridge 0.1.0' ;;
  doctor) echo "error: unrecognized subcommand 'doctor'" >&2; exit 2 ;;
  windows) echo '[]' ;;
  forget-session) [ "$2" = --help ] && exit 0; echo "unexpected $*" >> "${root}/forbidden"; exit 1 ;;
  *) echo "unexpected $1" >> "${root}/forbidden"; exit 1 ;;
esac
`;
  const electron = fakeTree(join(root, "tree"), { "gnome-portal-bridge": gnome, "kwin-portal-bridge": kwin });
  const r = spawnSync(BASH, [launcherPath, "--diagnose"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: electron, XDG_STATE_HOME: state,
           XDG_RUNTIME_DIR: join(root, "run"), XDG_SESSION_TYPE: "wayland",
           WAYLAND_DISPLAY: "wayland-9", XDG_CURRENT_DESKTOP: "GNOME" },
    encoding: "utf8", timeout: 90000,
  });
  const out = r.stdout || "";
  check("exit status", r.status, 0);
  const sec = out.slice(out.indexOf("--- Computer Use bridges (CLI contract) ---"), out.indexOf("--- Local Cowork VM"));
  check("section present", sec.length > 0, true);
  const g = sec.slice(sec.indexOf("[gnome-portal-bridge]"), sec.indexOf("[kwin-portal-bridge]"));
  const k = sec.slice(sec.indexOf("[kwin-portal-bridge]"));
  check("contract 0 is named", g.includes("doctor: contract 0") && k.includes("doctor: contract 0"), true);
  check("GNOME grant from its (pre-contract) doctor", g.includes("remembered choice = yes"), true);
  check("GNOME daemon from its doctor", g.includes("session daemon = running"), true);
  check("GNOME screens on a GNOME Wayland session", g.includes("gnome-portal-bridge screens = ok"), true);
  check("shared monitor", g.includes("monitor eDP-1 = shared"), true);
  check("unshared monitor", g.includes("monitor HDMI-1 = NOT SHARED"), true);
  check("KDE grant from its token file", k.includes("remembered choice = yes"), true);
  check("KDE daemon from its socket", k.includes("session daemon = not running"), true);
  check("the reset flag is named", sec.includes("claude-desktop --reset-screen-sharing"), true);
  check("no state-changing bridge call", existsSync(join(root, "forbidden")) ? readFileSync(join(root, "forbidden"), "utf8") : "", "");
});

// ---------------------------------------------------------------- D9
// Bridges on the CLI contract (docs/computer-use-bridge-contract.md): the
// launcher knows them only through doctor - including a bridge it has never
// heard of - and reads pretty-printed JSON without jq or python3.
console.log("D9: contract-1 bridges, discovered generically");
const doctorJson = (name, o) => JSON.stringify({
  contract: 1, bridge: name, version: "2.0.0", backend: o.backend,
  session_match: !!o.match, backend_reachable: o.reachable !== false,
  backend_error: o.reachable === false ? "cannot open display" : null,
  session_supported: !!o.supported, restore_token_present: !!o.token,
  restore_token_path: o.supported ? `/s/${name}/restore-token.json` : null,
  daemon_running: !!o.daemon, session_socket: o.supported ? `/r/${name}/session.sock` : null,
  ...(o.stopped === undefined ? {} : { stopped_by_user: o.stopped }),
  extra_key: { nested: true },
}, null, 2);
// A stub bridge: logs "<name> <subcommand>" to calls, answers from o.
function contractStub(name, o, calls) {
  const reply = (sub, text) => `  ${sub}) cat <<'JSON'\n${text}\nJSON\n  ;;\n`;
  return `#!/bin/sh\necho "${name} $1" >> '${calls}'\ncase "$1" in\n` +
    `  --version) echo '${name} 2.0.0' ;;\n` +
    (o.contract0 ? `  doctor) echo "error: unrecognized subcommand 'doctor'" >&2; exit 2 ;;\n` : reply("doctor", doctorJson(name, o))) +
    reply("screens", o.screens || "[]") +
    reply("forget-session", o.forget || '{"ok":true,"ended":false,"daemon":"none","token_removed":false,"token_path":null}') +
    `  *) exit 2 ;;\nesac\n`;
}
safe("D9", () => {
  const root = join(scratch, "d9");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const calls = join(root, "calls");
  const PRETTY_SCREENS = JSON.stringify([
    { id: "eDP-1", name: "eDP-1", geometry: { x: 0, y: 0, width: 1920, height: 1080 }, is_primary: true, is_shared: true },
    { id: "DP-2", name: "DP-2", geometry: { x: 1920, y: 0, width: 2560, height: 1440 }, is_primary: false, is_shared: false },
  ], null, 2);
  const electron = fakeTree(join(root, "tree"), {
    "x11-bridge": contractStub("x11-bridge", { backend: "x11", match: true, reachable: false,
      screens: '[{"id":"X","name":"X","geometry":{"x":0,"y":0,"width":1,"height":1}}]' }, calls),
    "wlroots-bridge": contractStub("wlroots-bridge", { backend: "wlroots" }, calls),
    "gnome-portal-bridge": contractStub("gnome-portal-bridge", { backend: "gnome-portal", match: true, supported: true,
      token: true, daemon: true, stopped: true, screens: PRETTY_SCREENS,
      forget: '{\n  "ok": true,\n  "ended": true,\n  "daemon": "shutdown-requested",\n  "token_removed": true,\n  "token_path": "/s/g"\n}' }, calls),
    "kwin-portal-bridge": contractStub("kwin-portal-bridge", { backend: "kwin-portal", supported: true, stopped: false,
      forget: '{\n  "ok": true,\n  "ended": false,\n  "daemon": "none",\n  "token_removed": false,\n  "token_path": "/s/k"\n}' }, calls),
    "foo-bridge": contractStub("foo-bridge", { backend: "foo", supported: true, token: true,
      forget: '{"ok":true,"ended":false,"daemon":"none","token_removed":true,"token_path":"/s/f"}' }, calls),
  });
  const env = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: electron, XDG_RUNTIME_DIR: join(root, "run"),
                XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-9", XDG_CURRENT_DESKTOP: "GNOME" };
  const called = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];

  let r = spawnSync(BASH, [launcherPath, "--reset-screen-sharing"], { env, encoding: "utf8", timeout: 60000 });
  const out = (r.stdout || "") + (r.stderr || "");
  check("reset: exit 0", r.status, 0);
  check("reset: GNOME (daemon shutdown-requested counts as ended)",
    out.includes("GNOME screen sharing: remembered choice removed and the running screen-sharing session ended; the next Computer Use task will ask again."), true);
  check("reset: KDE", out.includes("KDE screen sharing: nothing to reset."), true);
  check("reset: an unknown bridge with a session is reset too",
    out.includes("foo-bridge screen sharing: remembered choice removed; the next Computer Use task will ask again."), true);
  const forgets = called().filter((l) => l.endsWith(" forget-session")).map((l) => l.split(" ")[0]).sort().join(",");
  check("reset: forget-session only where doctor says session_supported", forgets, "foo-bridge,gnome-portal-bridge,kwin-portal-bridge");

  rmSync(calls, { force: true });
  r = spawnSync(BASH, [launcherPath, "--diagnose"], { env, encoding: "utf8", timeout: 90000 });
  const d = r.stdout || "";
  check("diagnose: exit 0", r.status, 0);
  check("diagnose: the unknown bridge is run and listed", d.includes("foo-bridge runs = ok foo-bridge 2.0.0") && d.includes("[foo-bridge]"), true);
  check("diagnose: doctor's required keys, read from pretty-printed JSON",
    d.includes("  doctor: contract=1 backend=gnome-portal session_match=true backend_reachable=true backend_error=null " +
      "session_supported=true restore_token_present=true restore_token_path=/s/gnome-portal-bridge/restore-token.json " +
      "daemon_running=true session_socket=/r/gnome-portal-bridge/session.sock"), true);
  // Optional doctor key stopped_by_user: one line where it is true, none where
  // it is false (kwin) or absent (the others).
  const STOPPED_LINE = "  stopped_by_user: screen sharing was stopped by the user; the next Computer Use task starts it again";
  const section = (n) => { const i = d.indexOf(`[${n}] `); const j = d.indexOf("\n[", i + 1); return i < 0 ? "" : d.slice(i, j < 0 ? d.length : j); };
  check("diagnose: stopped_by_user true -> the stop is named", section("gnome-portal-bridge").includes(STOPPED_LINE), true);
  check("diagnose: stopped_by_user false or absent -> no line", d.split(STOPPED_LINE).length - 1, 1);
  const screensBy = called().filter((l) => l.endsWith(" screens")).map((l) => l.split(" ")[0]).sort().join(",");
  check("diagnose: screens only where session_match and the backend is reachable", screensBy, "gnome-portal-bridge");
  check("diagnose: an unreachable backend prints its reason instead",
    d.includes("  screens skipped: backend unreachable (cannot open display)"), true);
  check("diagnose: per-monitor sharing from pretty-printed screens",
    d.includes("    monitor eDP-1 = shared") && d.includes("    monitor DP-2 = NOT SHARED"), true);
  check("diagnose: no is_shared, no monitor lines", /\[x11-bridge\][\s\S]*?monitor X =/.test(d.slice(0, d.indexOf("[foo-bridge]") > 0 ? d.length : 0)), false);
  check("diagnose: never forget-session or session-start",
    called().some((l) => / (forget-session|session-start|session-end)$/.test(l)), false);
  check("diagnose: the reset is advertised (bridges with a session exist)", d.includes("claude-desktop --reset-screen-sharing forgets"), true);
  const problems = d.slice(d.indexOf("--- Problems found ---"));
  check("diagnose: an unreachable backend on this session is a problem",
    /^- x11-bridge serves this session but its backend is unreachable: cannot open display$/m.test(problems), true);

  // One bridge below the contract next to contract-1 ones.
  const root2 = join(root, "mixed");
  const calls2 = join(root2, "calls");
  mkdirSync(root2, { recursive: true });
  const electron2 = fakeTree(join(root2, "tree"), {
    "gnome-portal-bridge": contractStub("gnome-portal-bridge", { backend: "gnome-portal", supported: true }, calls2),
    "kwin-portal-bridge": contractStub("kwin-portal-bridge", { contract0: true,
      forget: '{\n  "daemon": "none",\n  "ended": false,\n  "ok": true,\n  "token_path": "/y",\n  "token_removed": true\n}' }, calls2),
    "wlroots-bridge": contractStub("wlroots-bridge", { contract0: true }, calls2),
  });
  r = spawnSync(BASH, [launcherPath, "--reset-screen-sharing"], { env: { ...env, CLAUDE_ELECTRON: electron2 }, encoding: "utf8", timeout: 60000 });
  check("contract 0: kwin-portal-bridge still reset by name",
    (r.stdout || "").includes("KDE screen sharing: remembered choice removed; the next Computer Use task will ask again."), true);
  const f2 = readFileSync(calls2, "utf8").split("\n").filter((l) => l.endsWith(" forget-session")).map((l) => l.split(" ")[0]).sort().join(",");
  check("contract 0: other pre-contract bridges are left alone", f2, "gnome-portal-bridge,kwin-portal-bridge");
});

// ---------------------------------------------------------------- D10
// scripts/check-bridge-contract.sh (CI) against stub bridges: a compliant
// pair passes, a bridge that deletes more than its token fails loudly.
console.log("D10: check-bridge-contract.sh");
safe("D10", () => {
  const PY = (spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout || "").trim();
  if (!PY) { console.log("  SKIP python3 not found"); return; }
  const checker = join(repo, "scripts", "check-bridge-contract.sh");
  const stub = (name, supported, forgetRm = "rm -f \"$f\"") => `#!/bin/sh
NAME=${name}
case "$1" in
  --version) echo "$NAME 1.0.0" ;;
  doctor)
    if [ ${supported} = true ]; then tp="\\"$XDG_STATE_HOME/$NAME/restore-token.json\\""; sk="\\"$XDG_RUNTIME_DIR/$NAME/session.sock\\""; else tp=null; sk=null; fi
    printf '{\\n  "contract": 1,\\n  "bridge": "%s",\\n  "version": "1.0.0",\\n  "backend": "x",\\n  "session_match": false,\\n  "backend_reachable": false,\\n  "backend_error": "no display",\\n  "session_supported": ${supported},\\n  "restore_token_present": false,\\n  "restore_token_path": %s,\\n  "daemon_running": false,\\n  "session_socket": %s\\n}\\n' "$NAME" "$tp" "$sk" ;;
  session-end) echo '{"ok":true,"ended":false,"daemon":"none"}' ;;
  forget-session)
    if [ ${supported} != true ]; then echo '{"ok":true,"ended":false,"daemon":"none","token_removed":false,"token_path":null}'; exit 0; fi
    f="$XDG_STATE_HOME/$NAME/restore-token.json"; r=false; [ -f "$f" ] && ${forgetRm} && r=true
    echo "{\\"ok\\":true,\\"ended\\":false,\\"daemon\\":\\"none\\",\\"token_removed\\":$r,\\"token_path\\":\\"$f\\"}" ;;
  screens|windows|session-start|pointer-move) for a in "$@"; do [ "$a" = --help ] && exit 0; done; exit 1 ;;
  *) echo "error: unrecognized subcommand '$1'" >&2; exit 2 ;;
esac
`;
  const good = join(scratch, "d10", "good");
  writeExe(join(good, "gnome-portal-bridge"), stub("gnome-portal-bridge", "true"));
  writeExe(join(good, "x11-bridge"), stub("x11-bridge", "false"));
  writeExe(join(good, "README"), "not a bridge\n");
  let r = spawnSync(BASH, [checker, good], { encoding: "utf8", timeout: 120000 });
  check("compliant bridges: exit 0", r.status, 0);
  check("compliant bridges: 2 checked, no FAIL",
    (r.stdout || "").includes("2 bridge(s): 20 passed, 0 failed") && !/^FAIL/m.test(r.stdout || ""), true);
  const bad = join(scratch, "d10", "bad");
  writeExe(join(bad, "kwin-portal-bridge"), stub("kwin-portal-bridge", "true", 'rm -rf "$(dirname "$f")"'));
  r = spawnSync(BASH, [checker, bad], { encoding: "utf8", timeout: 120000 });
  check("a bridge deleting the token's siblings: exit 1", r.status, 1);
  check("...named in a FAIL line", /^FAIL kwin-portal-bridge: forget-session with a stored grant - deleted a sibling file/m.test(r.stdout || ""), true);
  r = spawnSync(BASH, [checker, join(scratch, "d10")], { encoding: "utf8", timeout: 60000 });
  check("a dir without bridges fails", r.status === 1 && (r.stdout || "").includes("FAIL no executable *-bridge"), true);
});

// ---------------------------------------------------------------- D11
// Portal bridges that cannot execute here (glibc older than 2.39 on RHEL 9 /
// Ubuntu 22.04, no libpipewire, a foreign ELF loader on NixOS) never stored a
// grant: the reset says so and succeeds, even on X11.
console.log("D11: --reset-screen-sharing with bridges that cannot run");
safe("D11", () => {
  const root = join(scratch, "d11");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const cannotLoad = "#!/bin/sh\necho \"./b: error while loading shared libraries: libpipewire-0.3.so.0: cannot open shared object file\" >&2\nexit 127\n";
  const x11 = contractStub("x11-bridge", { backend: "x11", match: true }, join(root, "calls"));
  const electron = fakeTree(join(root, "tree"), { "gnome-portal-bridge": cannotLoad, "kwin-portal-bridge": cannotLoad, "x11-bridge": x11 });
  const env = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: electron, XDG_RUNTIME_DIR: join(root, "run"),
                DISPLAY: ":0", XDG_SESSION_TYPE: "x11" };
  let r = spawnSync(BASH, [launcherPath, "--reset-screen-sharing"], { env, encoding: "utf8", timeout: 60000 });
  const out = (r.stdout || "") + (r.stderr || "");
  check("cannot run: exit 0", r.status, 0);
  check("cannot run: GNOME and KDE say nothing is stored",
    out.includes("GNOME screen sharing: bridge cannot run on this system, nothing stored.")
      && out.includes("KDE screen sharing: bridge cannot run on this system, nothing stored."), true);
  check("cannot run: no FAILED line", out.includes("FAILED"), false);
  check("cannot run: x11-bridge (no session) is not touched", existsSync(join(root, "calls")) && readFileSync(join(root, "calls"), "utf8").includes("forget-session"), false);
  // --version runs, but forget-session itself cannot execute (126/127).
  const half = "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'gnome-portal-bridge 0.1.0'; exit 0; }\nexit 126\n";
  const electron2 = fakeTree(join(root, "tree2"), { "gnome-portal-bridge": half });
  r = spawnSync(BASH, [launcherPath, "--reset-screen-sharing"], { env: { ...env, CLAUDE_ELECTRON: electron2 }, encoding: "utf8", timeout: 60000 });
  check("forget-session exit 126: reported as cannot run, exit 0",
    r.status === 0 && (r.stdout || "").includes("GNOME screen sharing: bridge cannot run on this system, nothing stored."), true);

  // --diagnose does not advertise a reset nothing can do.
  const old = "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'gnome-portal-bridge 0.0.1' ;;\n  *) echo \"error: unrecognized subcommand '$1'\" >&2; exit 2 ;;\nesac\n";
  const electron3 = fakeTree(join(root, "tree3"), {
    "x11-bridge": x11, "wlroots-bridge": contractStub("wlroots-bridge", { backend: "wlroots" }, join(root, "calls3")),
    "gnome-portal-bridge": old, "kwin-portal-bridge": cannotLoad });
  r = spawnSync(BASH, [launcherPath, "--diagnose"], { env: { ...env, CLAUDE_ELECTRON: electron3 }, encoding: "utf8", timeout: 90000 });
  check("diagnose without a resettable bridge: no reset footer", (r.stdout || "").includes("--reset-screen-sharing forgets"), false);
});

// ---------------------------------------------------------------- D12
// Device key lines (cloud Cowork / Dispatch Computer Use): TPM access, the
// opt-in rule link and the last remote-device connect, plus their Problems.
// Fake /dev and /etc paths are passed as arguments; the main.log parsing reads
// the fixture the Extra settings status panel's harness reads too.
console.log("D12: --diagnose device key (TPM), rule link and last connect");
safe("D12", () => {
  const root = join(scratch, "d12");
  const res = join(root, "tree", "resources");
  const udev = join(res, "linux-udev");
  const rule = join(udev, "70-claude-desktop-extra-tpm.rules");
  mkdirSync(udev, { recursive: true });
  writeFileSync(rule, "# rule\n");
  const fixture = join(repo, "scripts", "tests", "fixtures", "main-log-device.txt");
  if (!existsSync(fixture)) throw new Error("shared fixture scripts/tests/fixtures/main-log-device.txt missing");
  const env = { PATH: "/usr/bin:/bin" };
  const FNS = ["_diag_tpm_state", "_cdb_tpm_rule_ours", "_diag_tpm_rule", "_diag_last_connect", "_diag_device_key"];
  const dk = (dev, link, log, extra = "") => runFns(FNS,
    `_diag_problems=(); ${extra} _diag_device_key '${dev}' '${link}' '${res}' '${log}'; printf 'P=%s\\n' "\${_diag_problems[@]:-}"`, env);
  const lines = (o) => o.out.split("\n");
  const problems = (o) => lines(o).filter((l) => l.startsWith("P=")).map((l) => l.slice(2)).filter(Boolean);

  const devOk = join(root, "tpmrm0-ok");
  writeFileSync(devOk, "");
  chmodSync(devOk, 0o600);
  const devDenied = join(root, "tpmrm0-denied");
  writeFileSync(devDenied, "");
  chmodSync(devDenied, 0o000);
  const isRoot = process.getuid && process.getuid() === 0;
  const link = join(root, "rules.d", "70-claude-desktop-extra-tpm.rules");
  mkdirSync(dirname(link), { recursive: true });
  const noLog = join(root, "no-such-main.log");

  // TPM states, in contract order (three lines, this order).
  let o = dk(devOk, link, fixture);
  check("ok: three lines in order", lines(o).slice(0, 3).map((l) => l.split(" = ")[0]).join("|"),
    "device key (TPM)|TPM access rule|last remote-device connect");
  check("ok line", lines(o)[0], `device key (TPM) = ok (${devOk} rw)`);
  check("no link: not enabled", lines(o)[1], "TPM access rule = not enabled");
  check("fixture: last connect of the log is keyed", lines(o)[2], "last remote-device connect = keyed (2026-11-03 12:21:03)");
  check("ok + keyed: no problem", problems(o).length, 0);
  o = dk(join(root, "absent"), link, noLog);
  check("absent line", lines(o)[0], "device key (TPM) = absent (no TPM 2.0 resource manager)");
  check("no main.log: not seen", lines(o)[2], "last remote-device connect = not seen");
  check("absent: no problem", problems(o).length, 0);
  if (isRoot) {
    console.log("  SKIP NOT ACCESSIBLE cases (running as root)");
  } else {
    o = dk(devDenied, link, fixture);
    const owner = spawnSync("stat", ["-c", "%U:%G", devDenied], { encoding: "utf8" }).stdout.trim();
    check("denied line names owner, group and octal mode", lines(o)[0], `device key (TPM) = NOT ACCESSIBLE (${owner} 0000)`);
    check("denied: the fix problem", problems(o)[0],
      `cloud Cowork and Dispatch get no Computer Use: the device key needs ${devDenied} - Settings -> Extra -> Cowork (Linux) -> Enable TPM access, or sudo ${udev}/cdb-tpm-access enable; without logind: sudo usermod -aG tss $USER and log in again`);
    o = dk(devDenied, link, fixture, "CLAUDE_APPIMAGE_PATH=/x/Claude.AppImage;");
    check("denied on AppImage: the copy command instead of the image's helper",
      problems(o)[0].includes(`or sudo install -m 0644 ${rule} ${link} && sudo udevadm control --reload && sudo udevadm trigger --action=change --subsystem-match=tpmrm;`), true);
  }

  // Last connect: keyless with its reason, none, unparsable.
  const log2 = join(root, "main-keyless.log");
  writeFileSync(log2, readFileSync(fixture, "utf8").split("\n").filter((l) => !l.includes("12:21:03") || !l.includes("device_id keyed")).join("\n"));
  o = dk(devOk, link, log2);
  check("keyless line with reason", lines(o)[2], "last remote-device connect = keyless (row_pk_no_row) (2026-11-03 12:20:58)");
  check("ok + keyless: the Q6 problem", problems(o)[0],
    `device registered keyless (row_pk_no_row) although ${devOk} is accessible: restart Claude; if it stays keyless, attach this report to an issue`);
  const log3 = join(root, "main-none.log");
  writeFileSync(log3, "2026-11-03 13:00:00 [info] [remote-tools-device] connect frame sent: device_id none\n");
  check("none line", lines(dk(devOk, link, log3))[2], "last remote-device connect = none (2026-11-03 13:00:00)");
  const log4 = join(root, "main-moved.log");
  writeFileSync(log4, "2026-11-03 13:00:00 [info] [remote-tools-device] connect frame sent: deviceId=keyed\n");
  check("moved wording: not seen", lines(dk(devOk, link, log4))[2], "last remote-device connect = not seen");

  // Rule link states.
  const ruleLine = (setup) => { rmSync(link, { force: true }); setup(); const r = dk(devOk, link, fixture); return [lines(r)[1], problems(r)]; };
  const sym = (t) => spawnSync("ln", ["-s", t, link]);
  // A link into this run's own tree (an AppImage mount, a build tree) is not
  // ours: the tree goes away and whoever recreates the path writes a root rule.
  let [l, p] = ruleLine(() => sym(rule));
  check("link to this run's tree: unsafe, remove it", l, `TPM access rule = unsafe link (-> ${rule}, not an installed claude-desktop-extra rule - remove it)`);
  check("unsafe: the rm problem", p[0], `TPM access rule link points outside an installed claude-desktop-extra rule (udev reads it as root), remove it: sudo rm -f ${link} && sudo udevadm control --reload`);
  const goneStore = "/nix/store/00000000000000000000000000000000-claude-desktop-extra-1.0/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules";
  [l, p] = ruleLine(() => sym(goneStore));
  check("dangling Nix store link: stale", l, `TPM access rule = stale link (-> ${goneStore}, missing)`);
  check("stale: the re-point problem", p[0], `TPM access rule link points at a removed install: sudo ${udev}/cdb-tpm-access enable`);
  [l] = ruleLine(() => sym("/usr/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules"));
  check("package path link: ours (enabled or stale, never foreign)", /^TPM access rule = (enabled \(link -> |stale link \(-> )\/usr\/lib\/claude-desktop\//.test(l), true);
  [l, p] = ruleLine(() => sym("/nix/store/a/b/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules"));
  check("store path with two segments: unsafe", l.startsWith("TPM access rule = unsafe link (-> /nix/store/a/b/"), true);
  [l, p] = ruleLine(() => sym("/nix/store/0000000000000000000000000000000-x/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules"));
  check("store path with a 31-char hash: unsafe (the helper's exact shape only)", l.startsWith("TPM access rule = unsafe link "), true);
  [l, p] = ruleLine(() => sym("/etc/hostname"));
  check("other target: unsafe", l, "TPM access rule = unsafe link (-> /etc/hostname, not an installed claude-desktop-extra rule - remove it)");
  check("unsafe: one problem with the rm command", p.length === 1 && p[0].includes(`sudo rm -f ${link}`), true);
  [l, p] = ruleLine(() => sym("/dev/null"));
  check("link to /dev/null: masked, no problem", `${l}|${p.length}`, "TPM access rule = masked (link -> /dev/null)|0");
  [l] = ruleLine(() => writeFileSync(link, "# admin copy\n"));
  check("regular file: not managed", l, "TPM access rule = enabled (file, not managed by claude-desktop-extra)");
  rmSync(link, { force: true });

  // The real --diagnose prints the three lines inside --- Cloud Cowork device key ---.
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "Claude", "logs"), { recursive: true });
  writeFileSync(join(home, ".config", "Claude", "logs", "main.log"), readFileSync(fixture));
  const electron = fakeTree(join(root, "tree2"), { "x11-bridge": "#!/bin/sh\necho 'x11-bridge 0.1.0'\n" });
  const r = spawnSync(BASH, [launcherPath, "--diagnose"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: electron, XDG_RUNTIME_DIR: join(root, "run"),
           DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, encoding: "utf8", timeout: 90000 });
  const d = r.stdout || "";
  check("diagnose: exit 0", r.status, 0);
  const cu = d.slice(d.indexOf("--- Cloud Cowork device key ---"), d.indexOf("--- Computer Use bridges"));
  check("diagnose: device key line in the Cloud Cowork device key section", /^device key \(TPM\) = (ok \(\/dev\/tpmrm0 rw\)|NOT ACCESSIBLE \(.+ [0-7]{4}\)|absent \(no TPM 2\.0 resource manager\))$/m.test(cu), true);
  check("diagnose: rule line follows", /^device key \(TPM\) = .*\nTPM access rule = .*\nlast remote-device connect = /m.test(cu), true);
  check("diagnose: last connect read from the profile's main.log", cu.includes("last remote-device connect = keyed (2026-11-03 12:21:03)"), true);
});

// ---------------------------------------------------------------- D13
// cdb-tpm-access: the real helper with its fixed system paths pointed into a
// scratch dir, the root/ownership checks keyed to this user, the scratch
// install added to its known rule paths and the scratch dir's sticky ancestors
// (/tmp) to its sticky exception, so every exit code path runs unprivileged.
// A fake udevadm records its calls.
console.log("D13: cdb-tpm-access helper (paths rewritten into a scratch dir)");
safe("D13", () => {
  const helperSrc = readFileSync(join(repo, "packaging", "udev", "cdb-tpm-access"), "utf8");
  const uid = String(process.getuid());
  const root = join(scratch, "d13");
  const etc = join(root, "etc");
  const calls = join(root, "udevadm.calls");
  const fakeUdevadm = join(root, "bin", "udevadm");
  const inst = join(root, "lib", "linux-udev");
  const sticky = [];
  for (let d = scratch; dirname(d) !== d; d = dirname(d)) {
    if (existsSync(d) && (lstatSync(d).mode & 0o1000)) sticky.push(d);
  }
  writeExe(fakeUdevadm, `#!/bin/sh\necho "$*" >> '${calls}'\n[ -e '${root}/udevadm-fail' ] && exit 1\nexit 0\n`);
  const subst = [
    ['RULES_DIR=/etc/udev/rules.d', `RULES_DIR=${etc}/udev/rules.d`],
    ['[ "$("$ID" -u)" = 0 ]', `[ "$("$ID" -u)" = ${uid} ]`],
    ['[ "$_uid" = 0 ] || return 1', `{ [ "$_uid" = 0 ] || [ "$_uid" = ${uid} ]; } || return 1`],
    ["CONTAINER_MARKERS='/run/systemd/container\n/.dockerenv\n/run/.containerenv\n/.flatpak-info'", `CONTAINER_MARKERS='${root}/nothing-here\n${root}/containerenv'`],
    ['UDEV_CONTROL=/run/udev/control', `UDEV_CONTROL=${root}/udev-control`],
    ['[ -S "$UDEV_CONTROL" ]', '[ -e "$UDEV_CONTROL" ]'],
    // No tpmrm node in the scratch /dev: disable has no ACL step here
    // (scripts/tests/linux/test-tpm-access-helper.mjs covers it).
    ['DEV_DIR=/dev', `DEV_DIR=${root}/dev`],
    ['UDEVADM=$(tool udevadm)', `UDEVADM=${fakeUdevadm}`],
    ['NIXOS_MARKER=/etc/NIXOS', `NIXOS_MARKER=${etc}/NIXOS`],
    ['ETC_UDEV=/etc/udev', `ETC_UDEV=${etc}/udev`],
  ];
  const known = ['"$PKG_SRC") return 0 ;;', `"$PKG_SRC"|'${inst}/'"$RULE") return 0 ;;`];
  const stickyOk = ['[ "$1" = /nix/store ]', `{ ${["/nix/store", ...sticky].map((d) => `[ "$1" = '${d}' ]`).join(" || ")}; }`];
  const build = (list) => {
    let src = helperSrc;
    for (const [a, b] of list) {
      if (src.split(a).length !== 2) throw new Error(`helper anchor not found exactly once: ${a}`);
      src = src.replace(a, b);
    }
    return src;
  };
  const src = build([...subst, known, stickyOk]);
  mkdirSync(etc, { recursive: true });
  const helper = join(inst, "cdb-tpm-access");
  const rule = join(inst, "70-claude-desktop-extra-tpm.rules");
  writeExe(helper, src);
  writeFileSync(rule, readFileSync(join(repo, "packaging", "udev", "70-claude-desktop-extra-tpm.rules")));
  chmodSync(rule, 0o644);
  writeFileSync(join(root, "udev-control"), "");
  const link = join(etc, "udev", "rules.d", "70-claude-desktop-extra-tpm.rules");
  const run = (...args) => {
    const r = spawnSync(helper, args, { env: { PATH: join(root, "bin") }, encoding: "utf8" });
    return { rc: r.status, out: r.stdout || "", err: r.stderr || "" };
  };
  const one = (r) => r.out.split("\n").filter(Boolean).length === 1 && r.out.startsWith("cdb-tpm-access: ");
  const udevCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim() : "";

  let r = run("bogus");
  check("usage: exit 2, nothing on stdout", `${r.rc}|${r.out}`, "2|");
  r = run();
  check("no argument: exit 2", r.rc, 2);
  r = run("enable", "extra");
  check("two arguments: exit 2", r.rc, 2);

  r = run("enable");
  check("enable: exit 0", r.rc, 0);
  check("enable: one stdout line", r.out.trim(), `cdb-tpm-access: enabled (${link} -> ${rule})`);
  check("enable: a symlink to the shipped rule (no copy)", lstatSync(link).isSymbolicLink() && readlinkSync(link) === rule, true);
  check("enable: reload, trigger tpmrm, settle", udevCalls(),
    "control --reload\ntrigger --action=change --subsystem-match=tpmrm\nsettle --timeout=10");
  rmSync(calls, { force: true });
  r = run("enable");
  check("enable again: already enabled, still re-triggers", `${r.rc}|${r.out.trim()}|${udevCalls().split("\n").length}`, "0|cdb-tpm-access: already enabled|3");

  // Stale link (an older Nix store install) is re-pointed.
  const store = "/nix/store/0000000000000000000000000000000z-claude-desktop-extra-1.0/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules";
  rmSync(link); spawnSync("ln", ["-s", store, link]);
  r = run("enable");
  check("stale store link: re-pointed", `${r.rc}|${r.out.trim()}`, `0|cdb-tpm-access: re-pointed (${link} -> ${rule})`);
  check("stale store link: now points at the shipped rule", readlinkSync(link), rule);
  check("stale store link: re-pointed by rename, no temp link left", readdirSync(dirname(link)).join(","), "70-claude-desktop-extra-tpm.rules");
  check("the re-point is ln -s to a temp name + mv -T, never ln -sfn", /"\$MV" -T -- "\$_tmp" "\$LINK"/.test(helperSrc) && !/ln -sfn|-sfn/.test(helperSrc), true);

  rmSync(calls, { force: true });
  r = run("disable");
  check("disable: one line, link gone", `${r.rc}|${one(r)}|${r.out.trim()}|${existsSync(link) || (() => { try { lstatSync(link); return true; } catch { return false; } })()}`,
    "0|true|cdb-tpm-access: disabled|false");
  check("disable: reload + trigger", udevCalls().split("\n").slice(0, 2).join("|"), "control --reload|trigger --action=change --subsystem-match=tpmrm");
  rmSync(calls, { force: true });
  r = run("disable");
  check("disable again: already disabled, udev re-applied (clears a left-behind ACL)", `${r.rc}|${r.out.trim()}|${udevCalls().split("\n").length}`, "0|cdb-tpm-access: already disabled|3");

  // Dangling link to the deb/rpm/pacman path (uninstalled package) is ours.
  spawnSync("ln", ["-s", "/usr/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules", link]);
  r = run("disable");
  check("package-path link: disabled", `${r.rc}|${r.out.trim()}`, "0|cdb-tpm-access: disabled");

  // Anything else at LINK is left alone (exit 4) on enable AND disable.
  writeFileSync(link, "# admin rule\n");
  for (const a of ["enable", "disable"]) {
    r = run(a);
    check(`regular file, ${a}: exit 4, untouched, stderr only`,
      `${r.rc}|${r.out}|${readFileSync(link, "utf8")}|${/^cdb-tpm-access: left alone: /.test(r.err)}`, "4||# admin rule\n|true");
  }
  rmSync(link);
  spawnSync("ln", ["-s", "/etc/hostname", link]);
  for (const a of ["enable", "disable"]) {
    r = run(a);
    check(`foreign symlink, ${a}: exit 4, untouched`, `${r.rc}|${readlinkSync(link)}`, "4|/etc/hostname");
  }
  rmSync(link);
  spawnSync("ln", ["-s", "/nix/store/x/y/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules", link]);
  check("store link with an extra segment: foreign, exit 4", run("disable").rc, 4);
  rmSync(link);
  spawnSync("ln", ["-s", "/nix/store/x/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules", link]);
  check("store link without a hash-name segment: foreign, exit 4", run("disable").rc, 4);
  rmSync(link);
  // A dangling link into a deleted /tmp tree (the hijack case) is never ours.
  spawnSync("ln", ["-s", "/tmp/cdb-gone-tree/resources/linux-udev/70-claude-desktop-extra-tpm.rules", link]);
  for (const a of ["enable", "disable"]) {
    r = run(a);
    check(`dangling link into a /tmp tree, ${a}: exit 4, untouched`, `${r.rc}|${readlinkSync(link)}`,
      "4|/tmp/cdb-gone-tree/resources/linux-udev/70-claude-desktop-extra-tpm.rules");
  }
  rmSync(link);
  spawnSync("ln", ["-s", store, link]);
  r = run("disable");
  check("dangling Nix store link: disabled", `${r.rc}|${r.out.trim()}`, "0|cdb-tpm-access: disabled");

  // The same helper at a location that is not a known rule path (a build tree or
  // extracted AppImage under /tmp): exit 5 before anything, even with root keyed.
  const tmpTree = join(root, "tree", "resources", "linux-udev");
  writeExe(join(tmpTree, "cdb-tpm-access"), build([...subst, stickyOk]));
  writeFileSync(join(tmpTree, "70-claude-desktop-extra-tpm.rules"), readFileSync(rule));
  chmodSync(join(tmpTree, "70-claude-desktop-extra-tpm.rules"), 0o644);
  r = { ...spawnSync(join(tmpTree, "cdb-tpm-access"), ["enable"], { env: { PATH: join(root, "bin") }, encoding: "utf8" }) };
  check("helper outside the known rule paths: exit 5, no link, says refused", `${r.status}|${r.stdout}|${existsSync(link)}|${/refused: .* is not an installed claude-desktop-extra rule/.test(r.stderr)}`,
    "5||false|true");
  // A sticky world-writable ancestor other than /nix/store is not accepted.
  if (sticky.length) {
    writeExe(helper, build([...subst, known]));
    r = run("enable");
    check(`sticky ancestor ${sticky.join(",")} not accepted: exit 5, no link`, `${r.rc}|${existsSync(link)}`, "5|false");
    writeExe(helper, src);
  } else {
    console.log("  SKIP the scratch dir has no sticky ancestor");
  }

  // Unsafe or missing shipped rule: exit 5, nothing linked.
  chmodSync(rule, 0o664);
  r = run("enable");
  check("group-writable rule: exit 5", `${r.rc}|${existsSync(link)}`, "5|false");
  chmodSync(rule, 0o644);
  chmodSync(inst, 0o777);
  check("world-writable rule dir: exit 5", run("enable").rc, 5);
  chmodSync(inst, 0o755);
  rmSync(rule);
  spawnSync("ln", ["-s", join(repo, "packaging", "udev", "70-claude-desktop-extra-tpm.rules"), rule]);
  check("rule is a symlink: exit 5", run("enable").rc, 5);
  rmSync(rule);
  check("rule missing: exit 5", run("enable").rc, 5);
  // Root-owned and at a known path, but not the shipped text: never linked.
  const shipped = readFileSync(join(repo, "packaging", "udev", "70-claude-desktop-extra-tpm.rules"));
  for (const [what, body] of [["an added RUN line", Buffer.concat([shipped, Buffer.from('SUBSYSTEM=="tpmrm", RUN+="/bin/sh -c id"\n')])],
    ["no trailing newline", shipped.subarray(0, shipped.length - 1)], ["a NUL byte appended", Buffer.concat([shipped, Buffer.from([0])])],
    ["empty", Buffer.alloc(0)]]) {
    writeFileSync(rule, body); chmodSync(rule, 0o644);
    r = run("enable");
    check(`rule with ${what}: exit 5, says it does not match, no link`,
      `${r.rc}|${r.out}|${/does not match the rule this helper ships/.test(r.err)}|${existsSync(link)}`, "5||true|false");
  }
  writeFileSync(rule, shipped);
  chmodSync(rule, 0o644);

  // No udev here / container / NixOS / udevadm failing.
  rmSync(join(root, "udev-control"));
  check("no udev control socket: exit 3", run("enable").rc, 3);
  writeFileSync(join(root, "udev-control"), "");
  writeFileSync(join(root, "containerenv"), "");
  r = run("enable");
  check("container: exit 3, says run it on the host", `${r.rc}|${r.err.includes("run this on the host")}`, "3|true");
  rmSync(join(root, "containerenv"));
  writeFileSync(join(etc, "NIXOS"), "");
  check("NixOS: exit 4 (module option instead)", run("enable").rc, 4);
  rmSync(join(etc, "NIXOS"));
  writeFileSync(join(root, "udevadm-fail"), "");
  r = run("enable");
  check("udevadm reload fails after the link: exit 3, no stdout", `${r.rc}|${r.out}`, "3|");
  rmSync(join(root, "udevadm-fail"));
  check("...and the link it made is ours: disable works", run("disable").rc, 0);

  // Unmodified helper from the source tree: not a known rule path, exit 5 before anything.
  const real = spawnSync(join(repo, "packaging", "udev", "cdb-tpm-access"), ["enable"], { encoding: "utf8" });
  check("real helper from the source tree: exit 5, nothing on stdout", `${real.status}|${real.stdout}`, "5|");
});

console.log("D14: --diagnose names the window identity this launch would use");
safe("D14", () => {
  const root = join(scratch, "d14");
  const home = join(root, "home");
  const electron = fakeTree(join(root, "tree"), {});
  const apps = join(home, ".local", "share", "applications");
  const diag = (args, extra = {}) => spawnSync(BASH, [launcherPath, ...args, "--diagnose"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_ELECTRON: electron,
           XDG_RUNTIME_DIR: join(root, "run"), XDG_DATA_DIRS: join(root, "nodata"), ...extra },
    encoding: "utf8", timeout: 90000,
  });
  const idLine = (r) => ((r.stdout || "").split("\n").find((l) => l.startsWith("window identity = ")) || "");
  const def = diag([]);
  check("default profile: base id only", idLine(def), "window identity = com.anthropic.Claude");
  const shared = diag(["--profile=work"]);
  check("named profile without the file: shared, with the reason",
    idLine(shared), "window identity = com.anthropic.Claude (shared: no com.anthropic.Claude-work.desktop in the XDG applications dirs)");
  mkdirSync(apps, { recursive: true });
  const f = join(apps, "com.anthropic.Claude-work.desktop");
  writeFileSync(f, "[Desktop Entry]\nName=Claude (work)\n");
  const own = diag(["--profile=work"]);
  check("named profile with the file: per-profile id and the file path", idLine(own), `window identity = com.anthropic.Claude-work (${f})`);
  writeFileSync(f, "[Desktop Entry]\nHidden=true\n");
  check("Hidden=true counts as absent", idLine(diag(["--profile=work"])).includes("(shared:"), true);
  rmSync(f);
  const dd = join(root, "datadir");
  mkdirSync(join(dd, "applications"), { recursive: true });
  writeFileSync(join(dd, "applications", "com.anthropic.Claude-work.desktop"), "[Desktop Entry]\nName=x\n");
  check("found through XDG_DATA_DIRS", idLine(diag(["--profile=work"], { XDG_DATA_DIRS: dd })),
    `window identity = com.anthropic.Claude-work (${join(dd, "applications", "com.anthropic.Claude-work.desktop")})`);
  // A `*` in XDG_DATA_DIRS is one literal path, never expanded onto siblings.
  const gd = join(root, "globdirs");
  mkdirSync(join(gd, "sib", "applications"), { recursive: true });
  writeFileSync(join(gd, "sib", "applications", "com.anthropic.Claude-work.desktop"), "[Desktop Entry]\nName=x\n");
  check("XDG_DATA_DIRS entry with `*` is not glob-expanded",
    idLine(diag(["--profile=work"], { XDG_DATA_DIRS: join(gd, "*") })).includes("(shared:"), true);
  mkdirSync(join(gd, "*", "applications"), { recursive: true });
  writeFileSync(join(gd, "*", "applications", "com.anthropic.Claude-work.desktop"), "[Desktop Entry]\nName=x\n");
  check("XDG_DATA_DIRS entry that is literally `*` is found as itself",
    idLine(diag(["--profile=work"], { XDG_DATA_DIRS: join(gd, "*") })),
    `window identity = com.anthropic.Claude-work (${join(gd, "*", "applications", "com.anthropic.Claude-work.desktop")})`);
  check("XDG_DATA_DIRS with empty entries still finds the real dir",
    idLine(diag(["--profile=work"], { XDG_DATA_DIRS: `::${dd}:` })).startsWith("window identity = com.anthropic.Claude-work ("), true);
  check("a relative XDG_DATA_HOME is ignored (falls back to ~/.local/share)",
    idLine(diag(["--profile=work"], { XDG_DATA_HOME: "rel" })).includes("(shared:"), true);
  check("default profile output keeps its single added line",
    (def.stdout || "").split("\n").filter((l) => l.startsWith("window identity")).length, 1);
});

// ---------------------------------------------------------------- D15
console.log("D15: _appimage_release_scheme splits XDG_DATA_DIRS without globbing");
safe("D15", () => {
  const root = join(scratch, "d15");
  const bin = join(root, "bin");
  const marker = join(root, "handed-back");
  mkdirSync(join(root, "home"), { recursive: true });
  // Fake xdg-mime: the default is this profile's entry until `default` is called.
  writeExe(join(bin, "xdg-mime"), `#!/bin/sh
if [ "$1" = query ]; then
  if [ -e ${marker} ]; then echo com.anthropic.Claude.desktop; else echo work.desktop; fi
else touch ${marker}; fi
`);
  const run = (dirs) => {
    rmSync(marker, { force: true });
    runFns(["_appimage_release_scheme"],
      `DESKTOP_ID=work; _appimage_release_scheme || true`,
      { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "nohome"), XDG_DATA_DIRS: dirs });
    return existsSync(marker);
  };
  const dd = join(root, "dd");
  mkdirSync(join(dd, "sib", "applications"), { recursive: true });
  writeFileSync(join(dd, "sib", "applications", "com.anthropic.Claude.desktop"), "x");
  check("plain list entry holding the default entry: scheme handed back", run(join(dd, "sib")), true);
  check("`*` entry is not glob-expanded onto a sibling: nothing handed back", run(join(dd, "*")), false);
  mkdirSync(join(dd, "*", "applications"), { recursive: true });
  writeFileSync(join(dd, "*", "applications", "com.anthropic.Claude.desktop"), "x");
  check("a directory literally named `*` is found", run(join(dd, "*")), true);
  check("empty entries are skipped", run(`::${join(dd, "sib")}:`), true);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(1);
}
