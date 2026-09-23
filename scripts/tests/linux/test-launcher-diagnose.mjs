#!/usr/bin/env node
// `claude-desktop --diagnose`: does it probe the host the way the APP does?
//
// WHY THIS EXISTS
// ---------------
// --diagnose is what an issue reporter pastes. It is only useful when each
// line answers the question the app itself asks:
//
//   - The app runs /usr/bin/{busctl,secret-tool,kwallet-query,sqlite3} by
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
for (const t of ["timeout", "head", "sed", "uname", "tr", "cat", "sleep", "printf"]) {
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
  writeExe(join(onPath, "sqlite3"), "#!/bin/sh\n");
  writeExe(join(onPath, "gjs"), "#!/bin/sh\n");
  const env = { PATH: `${onPath}:${coreBin}` };
  const cap = (args) => runFns(["_diag_cap"],
    `_diag_problems=(); _diag_cap ${args}; printf 'P=%s\\n' "\${_diag_problems[@]:-}"`, env).out;
  const up = cap(`fallback busctl ${abs}/busctl 1 'portal probe' 'hotkeys off'`);
  check("upstream path wins", /^\[ok\] +busctl = .*usr\/bin\/busctl \(upstream path\)/.test(up), true);
  const fb = cap(`fallback sqlite3 ${abs}/sqlite3 1 'recent projects' 'recent projects empty'`);
  check("PATH only is reported as our fallback",
    fb.includes(`sqlite3 = ${onPath}/sqlite3 (not at ${abs}/sqlite3; works through our PATH fallback)`), true);
  check("PATH only is not a problem", fb.endsWith("P="), true);
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
// What upstream 2.7032.0 runs (the fixed prefix of its busctl helper plus the
// GlobalShortcuts get-property argument list).
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
    const list = new RegExp(`\\[${APP_ARGV.slice(2).map(q).join(",")}\\]`).test(text);
    check("bundle: busctl helper prefix unchanged", prefix, true);
    check("bundle: GlobalShortcuts get-property argv unchanged", list, true);
  } else {
    console.log("  NOTE no extracted bundle; argv pinned to upstream 2.7032.0 only");
  }
});

// ---------------------------------------------------------------- D3
console.log("D3: bridges must run, with the preamble's causes and hints");
safe("D3", () => {
  const root = join(scratch, "d3");
  const env = { PATH: coreBin };
  const runs = (bin) => runFns(["_diag_bridge_runs"], `_diag_bridge_runs ${bin} X11_BRIDGE_BIN`, env).out;
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
    ["busctl", "secret-tool", "kwallet-query", "sqlite3", "xdg-open", "gjs", "python3", "socat"]
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

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(1);
}
