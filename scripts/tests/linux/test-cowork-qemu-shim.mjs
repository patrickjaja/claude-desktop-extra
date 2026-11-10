#!/usr/bin/env node
// Cowork's QEMU lookup on Linux: the app-side probe (our patch) and the
// launcher-side RHEL shim.
//
// WHY THIS EXISTS
// ---------------
// The Cowork capability probe needs an executable qemu-system-x86_64
// (qemu-system-aarch64 on arm64); without one Cowork is "unsupported". The
// resolved absolute path is passed to cowork-linux-helper, which execs it.
// Up to 3.6556.2 upstream walked process.env.PATH for the name. From 4.29.0 it
// only checks /usr/bin/qemu-system-<arch>, which loses every QEMU elsewhere:
// RHEL's qemu-kvm (via our rpm shim), NixOS (${qemu}/bin), /usr/local/bin.
// patches/linux/fix_cowork_firmware_paths_linux sub-patch D restores the lookup
// as: CLAUDE_QEMU_PATH (absolute), then upstream's /usr/bin path, then
// <dir>/qemu-system-<arch> for each absolute PATH dir, first X_OK hit wins.
//
// RHEL 9 / Rocky / Alma ship QEMU only as /usr/libexec/qemu-kvm (package
// qemu-kvm-core). Booted 2026-09-23 on rockylinux:9 (qemu-kvm
// 10.1.0-17.el9_8.5) through a `qemu-system-x86_64 -> /usr/libexec/qemu-kvm`
// symlink: the helper's exact command line (-machine q35,accel=kvm,
// vhost-vsock-pci, vhost-user-fs-pci, memory-backend-memfd, -sandbox on) runs
// unchanged and the guest reports ready.
//
// The rpm ships /usr/lib/claude-desktop/qemu-shim/qemu-system-<arch> symlinks.
// The launcher appends that dir to PATH (last, once; the patched probe's
// TOOL PATH step finds it because it is root-owned and read-only), when:
//   - /usr/libexec/qemu-kvm is executable,
//   - the shim exists (only the rpm ships it, so Fedora/Arch/Debian PATHs
//     are unchanged),
//   - it is not on PATH already.
// Another qemu-system-<arch> on PATH does not suppress it: the app ignores a
// copy in a user-writable dir, and a real QEMU in /usr/bin or a system dir is
// checked before the shim anyway.
//
// Q1-Q3 extract the launcher function and run it against scratch directories,
// and pin the rpm spec + the launcher call site. Q4-Q7 run the compiled patch
// over upstream's 4.29.0 probe shapes, execute the patched probe against
// scratch directories with the real fs, and check that the launcher's
// --diagnose replica (_cowork_qemu_probe) resolves the same path.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync,
  accessSync, constants as fsConstants, promises as fsp,
} from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const launcherSrc = readFileSync(join(repo, "scripts", "claude-desktop-launcher.sh"), "utf8");
const specSrc = readFileSync(join(repo, "packaging", "rpm", "claude-desktop-extra.spec"), "utf8");

const BASH = (spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout || "").trim();
if (!BASH) {
  console.log("SKIP: bash not found");
  process.exit(3);
}

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failures.push(label);
  }
}

function fn(name) {
  const re = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m");
  const m = launcherSrc.match(re);
  if (!m) throw new Error(`launcher function ${name}() not found`);
  return m[0];
}

const scratch = join(tmpdir(), `cdb-qemu-shim-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

function writeExe(path, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
}

// Fake RHEL: /usr/libexec/qemu-kvm stand-in + an rpm-style shim dir of symlinks.
const qemuKvm = join(scratch, "libexec", "qemu-kvm");
writeExe(qemuKvm);
const shim = join(scratch, "qemu-shim");
mkdirSync(shim, { recursive: true });
for (const a of ["x86_64", "aarch64"]) symlinkSync(qemuKvm, join(shim, `qemu-system-${a}`));
const sysBin = join(scratch, "usr-bin");
mkdirSync(sysBin, { recursive: true });
const realQemuBin = join(scratch, "real-qemu-bin");
writeExe(join(realQemuBin, "qemu-system-x86_64"));
writeExe(join(realQemuBin, "qemu-system-aarch64"));
const noExecBin = join(scratch, "noexec-bin");
writeExe(join(noExecBin, "qemu-system-x86_64"), 0o644);

function run(path, arch, kvm = qemuKvm, shimDir = shim) {
  let script;
  try {
    script = `${fn("_cowork_qemu_shim_path")}\n_cowork_qemu_shim_path "$1" "$2" "$3" "$4"`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
  const r = spawnSync(BASH, ["-c", script, "x", path, arch, kvm, shimDir], {
    env: { PATH: "/usr/bin:/bin" }, encoding: "utf8",
  });
  if (r.status !== 0) return `EXIT ${r.status}: ${r.stderr}`;
  return r.stdout.replace(/\n$/, "");
}

console.log("Q1: PATH decision (mirrors the app's X_OK PATH walk)");
const base = `${sysBin}:/nonexistent`;
check("RHEL x86_64, no qemu-system on PATH -> shim appended",
  run(base, "x86_64"), `${base}:${shim}`);
check("RHEL aarch64, no qemu-system on PATH -> shim appended",
  run(base, "aarch64"), `${base}:${shim}`);
check("another qemu-system-x86_64 on PATH (e.g. ~/.local/bin, ignored by the app) -> shim still appended, last",
  run(`${realQemuBin}:${base}`, "x86_64"), `${realQemuBin}:${base}:${shim}`);
check("another qemu-system-aarch64 on PATH -> shim still appended, last",
  run(`${realQemuBin}:${base}`, "aarch64"), `${realQemuBin}:${base}:${shim}`);
check("non-executable qemu-system-x86_64 on PATH -> shim appended",
  run(`${noExecBin}:${base}`, "x86_64"), `${noExecBin}:${base}:${shim}`);
check("PATH entry with a glob character is passed through untouched",
  run(`/opt/*:${base}`, "x86_64"), `/opt/*:${base}:${shim}`);
check("no /usr/libexec/qemu-kvm -> unchanged",
  run(base, "x86_64", join(scratch, "missing", "qemu-kvm")), base);
check("shim dir not installed (non-rpm package) -> unchanged",
  run(base, "x86_64", qemuKvm, join(scratch, "no-shim")), base);
check("unsupported arch -> unchanged", run(base, "riscv64"), base);
check("shim already on PATH (relaunch) -> unchanged",
  run(`${base}:${shim}`, "x86_64"), `${base}:${shim}`);
check("empty PATH entries are skipped, shim appended",
  run(`::${base}`, "x86_64"), `::${base}:${shim}`);

console.log("\nQ2: launcher call site");
const pathExport = launcherSrc.indexOf('\nexport PATH="$_claude_path"\n');
// Both PATH and _claude_path: the systemd-run scope exec re-sets PATH from
// _claude_path (--setenv=PATH=...), so updating PATH alone loses the shim there.
const callRe = /\n_claude_path="\$\(_cowork_qemu_shim_path "\$PATH" "\$\(uname -m\)" \/usr\/libexec\/qemu-kvm \/usr\/lib\/claude-desktop\/qemu-shim\)"\nPATH="\$_claude_path"\n/;
const call = launcherSrc.search(callRe);
const firstExec = launcherSrc.search(/\n\s*exec /);
check("launcher calls _cowork_qemu_shim_path with the rpm shim dir", call > 0, true);
check("call runs after the PATH repair (uname resolvable, PATH exported)",
  pathExport > 0 && call > pathExport, true);
check("call runs before the first exec", call > 0 && firstExec > call, true);
check("scope exec takes PATH from _claude_path (why the call updates it)",
  /--setenv="PATH=\$\{_claude_path\}"/.test(launcherSrc), true);
check("_claude_path is not reassigned after the shim call",
  call > 0 && !/\n\s*_claude_path=/.test(launcherSrc.slice(call + 2)), true);

console.log("\nQ3: rpm spec ships the shim");
for (const a of ["x86_64", "aarch64"]) {
  const re = new RegExp(
    `%ifarch ${a}\\n(?:.*\\n){0,4}?ln -s /usr/libexec/qemu-kvm %\\{buildroot\\}/usr/lib/claude-desktop/qemu-shim/qemu-system-${a}\\n`);
  check(`spec links qemu-system-${a} -> /usr/libexec/qemu-kvm under %ifarch ${a}`, re.test(specSrc), true);
}
check("spec creates the shim dir", specSrc.includes("mkdir -p %{buildroot}/usr/lib/claude-desktop/qemu-shim"), true);

// CI builds the rpm on Fedora, so a %{?rhel} branch never fires; the
// Recommends must name both distros' qemu packages in one rich dependency.
check("spec has no build-host-dependent %if 0%{?rhel} qemu branch", /%if 0%\{\?rhel\}\nRecommends:\s+qemu-kvm/.test(specSrc), false);
for (const [a, fedora] of [["x86_64", "qemu-system-x86"], ["aarch64", "qemu-system-aarch64"]]) {
  const re = new RegExp(`%ifarch ${a}\\nRecommends:\\s+\\(${fedora} or qemu-kvm\\)\\n`);
  check(`spec Recommends (${fedora} or qemu-kvm) under %ifarch ${a}`, re.test(specSrc), true);
}

// ---------------------------------------------------------------- patch D
// Upstream's 4.29.0 probe, verbatim shapes (index.chunk-Sq9qOqtc.js). The
// firmware/virtiofsd arrays are here because the patch requires all four of its
// sub-patches. `a` (node:fs) and `_` (node:fs/promises, interop-wrapped) are the
// chunk's own module bindings; the sandbox supplies them with the real fs.
const FIXTURE = `"use strict";
var GUn=process.arch==="arm64"?"/usr/bin/qemu-system-aarch64":"/usr/bin/qemu-system-x86_64",KUn=process.arch==="arm64"?["/usr/share/AAVMF/AAVMF_CODE.fd"]:["/usr/share/OVMF/OVMF_CODE_4M.fd","/usr/share/OVMF/OVMF_CODE.fd"],qUn=["/usr/libexec/virtiofsd","/usr/bin/virtiofsd"];async function QUn(e,t=a.constants.R_OK){for(let n of e)try{return await _.default.access(n,t),n}catch{}return null}function rWn(){return(async()=>{let[t,n,r]=await Promise.all([QUn([GUn],a.constants.X_OK),QUn(KUn),QUn(qUn)]);return{qemuPath:t,firmwarePath:n,virtiofsdPath:r}})()}
globalThis.__fixture={rWn};
`;
// 3.6556.2: PATH walk, no /usr/bin constant.
const OLD_FIXTURE = FIXTURE
  .replace(/var GUn=[^,]+,/, 'var GUn=process.arch==="arm64"?"qemu-system-aarch64":"qemu-system-x86_64",')
  .replace("QUn([GUn],a.constants.X_OK)", "bIn(GUn)");

const PATCH_BIN = join(repo, "patches", "linux", "fix_cowork_firmware_paths_linux");
let patchBin = true;
try {
  accessSync(PATCH_BIN, fsConstants.X_OK);
} catch {
  patchBin = false;
}

function runPatch(file) {
  try {
    return { status: 0, out: execFileSync(PATCH_BIN, [file], { encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { status: typeof e.status === "number" ? e.status : -1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

// Scratch host: a fake /usr/bin (the patched literal is pointed at it), an
// override binary, PATH dirs with a real QEMU, the RHEL shim, a non-executable
// copy, a dir whose name contains ',' and one reached through a relative entry.
const fakeUsrBin = join(scratch, "fake-usr-bin");
const overrideExe = join(scratch, "override", "my-qemu");
writeExe(overrideExe);
const overrideNoExec = join(scratch, "override", "noexec-qemu");
writeExe(overrideNoExec, 0o644);
const commaDir = join(scratch, "a,b");
writeExe(join(commaDir, "qemu-system-x86_64"));
const usrBinX = join(fakeUsrBin, "qemu-system-x86_64");
const usrBinA = join(fakeUsrBin, "qemu-system-aarch64");

function setUsrBin(present) {
  rmSync(fakeUsrBin, { recursive: true, force: true });
  mkdirSync(fakeUsrBin, { recursive: true });
  if (present) {
    writeExe(usrBinX);
    writeExe(usrBinA);
  }
}

async function probeJs(src, arch, env) {
  const sandbox = { process: { arch, env }, a: { constants: fsConstants }, _: { default: fsp }, Promise };
  vm.runInNewContext(src, vm.createContext(sandbox));
  return (await sandbox.__fixture.rWn()).qemuPath;
}

function probeSh(arch, env) {
  let script;
  try {
    script = `${fn("_cowork_qemu_probe")}\n_cowork_qemu_probe "$1" "$2" "$3" "$4"`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
  const bin = arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  const r = spawnSync(BASH, ["-c", script, "x", bin, env.PATH ?? "", env.CLAUDE_QEMU_PATH ?? "", fakeUsrBin], {
    env: { PATH: "/usr/bin:/bin" }, encoding: "utf8",
  });
  if (r.status === 1 && r.stdout === "") return null;
  if (r.status !== 0) return `EXIT ${r.status}: ${r.stderr}`;
  return r.stdout.replace(/\n$/, "");
}

if (!patchBin) {
  console.log(`\nQ4-Q7: SKIP (${PATCH_BIN.slice(repo.length + 1)} is not compiled; run: cd patches && make -j"$(nproc)")`);
} else {
  console.log("\nQ4: sub-patch D applies to the 4.29.0 probe");
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  const r1 = runPatch(file);
  check("patch exits 0", r1.status, 0);
  check("patch reports no failure", /\[FAIL\]/.test(r1.out), false);
  check("first run never says 'already' (absorption probe would read PARTIAL)", /already/i.test(r1.out), false);
  check("sub-patch D reports its injection", /\[OK\] qemu candidates: injected/.test(r1.out), true);
  const patched = readFileSync(file, "utf8");
  check("patched fixture passes node --check",
    spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }).status, 0);
  check("exactly one __cdbQemuCandidates", patched.split("function __cdbQemuCandidates(").length - 1, 1);
  check("upstream's single-candidate call is gone", patched.includes("QUn([GUn],"), false);
  check("upstream's /usr/bin constant is kept", patched.includes('"/usr/bin/qemu-system-x86_64"'), true);

  console.log("\nQ5: patched probe order (real fs, scratch dirs)");
  const src = patched
    .replace('"/usr/bin/qemu-system-x86_64"', JSON.stringify(usrBinX))
    .replace('"/usr/bin/qemu-system-aarch64"', JSON.stringify(usrBinA));
  const shimX = join(shim, "qemu-system-x86_64");
  const shimA = join(shim, "qemu-system-aarch64");
  const realX = join(realQemuBin, "qemu-system-x86_64");
  const realA = join(realQemuBin, "qemu-system-aarch64");
  // [label, usrBin present, arch, env, expected]
  const cases = [
    ["override wins over /usr/bin and PATH", true, "x64",
      { CLAUDE_QEMU_PATH: overrideExe, PATH: realQemuBin }, overrideExe],
    ["non-executable override falls through to /usr/bin", true, "x64",
      { CLAUDE_QEMU_PATH: overrideNoExec, PATH: realQemuBin }, usrBinX],
    ["relative override is ignored", false, "x64",
      { CLAUDE_QEMU_PATH: "override/my-qemu", PATH: realQemuBin }, realX],
    ["/usr/bin preferred over PATH", true, "x64", { PATH: realQemuBin }, usrBinX],
    ["/usr/bin preferred over PATH (arm64)", true, "arm64", { PATH: realQemuBin }, usrBinA],
    ["no /usr/bin: PATH fallback finds the RHEL shim", false, "x64", { PATH: `${sysBin}:${shim}` }, shimX],
    ["no /usr/bin: PATH fallback finds the RHEL shim (arm64)", false, "arm64", { PATH: `${sysBin}:${shim}` }, shimA],
    ["first executable PATH hit wins", false, "x64", { PATH: `${realQemuBin}:${shim}` }, realX],
    ["non-executable PATH entry skipped", false, "x64", { PATH: `${noExecBin}:${shim}` }, shimX],
    ["trailing slash in PATH dir normalized", false, "x64", { PATH: `${shim}//` }, shimX],
    ["relative and empty PATH entries skipped", false, "x64",
      { PATH: `::${relative(process.cwd(), realQemuBin)}:${shim}` }, shimX],
    ["PATH dir containing ',' skipped (helper rejects ',' and '=')", false, "x64",
      { PATH: `${commaDir}:${shim}` }, shimX],
    ["nothing found -> null", false, "x64", { PATH: `${sysBin}:/nonexistent` }, null],
    ["unset PATH, no /usr/bin -> null", false, "x64", {}, null],
  ];
  const results = [];
  for (const [label, usrBin, arch, env, expected] of cases) {
    setUsrBin(usrBin);
    const got = await probeJs(src, arch, env);
    check(label, got, expected);
    results.push([label, usrBin, arch, env, got]);
  }

  console.log("\nQ6: idempotency and fail-loud");
  const again = join(scratch, "again.js");
  writeFileSync(again, patched);
  const r2 = runPatch(again);
  check("second run exits 0", r2.status, 0);
  check("second run changes nothing", readFileSync(again, "utf8") === patched, true);
  check("second run asserts D positively", /\[OK\] qemu candidates:.*already present/.test(r2.out), true);
  const old = join(scratch, "old.js");
  writeFileSync(old, OLD_FIXTURE);
  check("3.6556.2 shape (PATH walk, no /usr/bin constant) -> exit 1", runPatch(old).status, 1);
  const two = join(scratch, "two.js");
  writeFileSync(two, FIXTURE.replace("QUn(KUn)", "QUn([GUn],a.constants.X_OK)"));
  check("two probe calls -> exit 1", runPatch(two).status, 1);
  const half = join(scratch, "half.js");
  writeFileSync(half, patched.replace("__cdbQemuCandidates", "__cdbQemuCandidatez"));
  check("marker altered (not our end state) -> exit 1", runPatch(half).status, 1);

  console.log("\nQ7: launcher --diagnose replica resolves the same path");
  for (const [label, usrBin, arch, env, got] of results) {
    setUsrBin(usrBin);
    check(`_cowork_qemu_probe: ${label}`, probeSh(arch, env), got);
  }
  setUsrBin(false);
  check("_cowork_qemu_probe: a glob PATH entry is not expanded (the app never globs)",
    probeSh("x64", { PATH: join(scratch, "real-qemu-*") }), null);
  check("--diagnose calls _cowork_qemu_probe on the TOOL PATH with CLAUDE_QEMU_PATH",
    launcherSrc.includes('_qemu_path="$(_cowork_qemu_probe "$_qemu_bin" "$_tool_path" "${CLAUDE_QEMU_PATH:-}")"') &&
    launcherSrc.includes('_tool_path="$(_diag_tool_path "${PATH:-}")"'), true);

  // Upstream (4.23118+) narrows process.env.PATH at startup to fixed system
  // dirs, so the shim dir the launcher appends is gone from it; the started
  // PATH survives in CLAUDE_DESKTOP_STARTED_PATH. The probe walks the TOOL
  // PATH of the shared resolver (js/tool_path.js): narrowed dirs + started dirs
  // that pass upstream's trust rule. The resolver judges ownership through a
  // stub fs (scratch dirs cannot be root-owned); the probe's own X_OK checks
  // use the real fs.
  console.log("\nQ8: under upstream's PATH narrowing (shared resolver)");
  const { makeHost, loadResolver } = await import("../lib/tool-path-vectors.mjs");
  const RESOLVER_SRC = readFileSync(join(repo, "js", "tool_path.js"), "utf8");
  const planted = join(scratch, "home-local-bin");
  writeExe(join(planted, "qemu-system-x86_64"));
  const anc = (p) => { const o = []; for (let d = p; d !== "/"; d = dirname(d)) o.push(d); return o; };
  const R = { uid: 0, ro: "EACCES" };
  const trustHost = () => {
    const dirs = {};
    for (const d of anc(scratch)) dirs[d] = R;
    dirs[shim] = R; dirs[realQemuBin] = R; dirs[sysBin] = R; dirs[planted] = { uid: 1000, ro: null };
    return makeHost({ dirs, files: [join(shim, "qemu-system-x86_64"), join(realQemuBin, "qemu-system-x86_64"), join(planted, "qemu-system-x86_64")] });
  };
  const nar = (started) => ({ PATH: sysBin, CLAUDE_DESKTOP_NARROWED_PATH: sysBin, CLAUDE_DESKTOP_STARTED_PATH: started });
  async function probeNarrowed(env, withResolver) {
    const sandbox = { process: { arch: "x64", env }, a: { constants: fsConstants }, _: { default: fsp }, Promise };
    const diag = [];
    if (withResolver === "throws") sandbox.__cdbToolPath = { toolPath() { throw new Error("resolver bug"); }, which() { throw new Error("resolver bug"); } };
    else if (withResolver) sandbox.__cdbToolPath = loadResolver(RESOLVER_SRC, trustHost(), env).raw;
    vm.runInNewContext(src, vm.createContext(sandbox));
    return { got: await sandbox.__fixture.rWn().then((r) => r.qemuPath), diag };
  }
  setUsrBin(false);
  const q8 = [
    ["RHEL: launcher-appended shim dir (root-owned, read-only) is found again", nar(`${sysBin}:${shim}`), true, join(shim, "qemu-system-x86_64")],
    ["planted ~/.local/bin copy ahead of the shim: the shim is taken", nar(`${planted}:${sysBin}:${shim}`), true, join(shim, "qemu-system-x86_64")],
    ["planted copy only: not handed to the helper", nar(`${planted}:${sysBin}`), true, null],
    ["root-managed dir outside the narrowed list (Nix wrapper store dir stand-in)", nar(`${planted}:${realQemuBin}`), true, join(realQemuBin, "qemu-system-x86_64")],
    ["narrowing off (PATH = started): the old PATH walk, unchanged", { PATH: `${planted}:${sysBin}`, CLAUDE_DESKTOP_STARTED_PATH: `${planted}:${sysBin}`, CLAUDE_DESKTOP_NARROWED_PATH: sysBin }, true, join(planted, "qemu-system-x86_64")],
    ["resolver missing: process.env.PATH (narrowed), as before", nar(`${sysBin}:${shim}`), false, null],
    ["resolver throws: the probe survives and walks process.env.PATH, as before", nar(`${sysBin}:${shim}`), "throws", null],
    ["resolver throws, narrowing off: old PATH walk finds the shim", { PATH: `${sysBin}:${shim}` }, "throws", join(shim, "qemu-system-x86_64")],
    ["CLAUDE_QEMU_PATH still wins (user-named)", { ...nar(`${sysBin}:${shim}`), CLAUDE_QEMU_PATH: overrideExe }, true, overrideExe],
  ];
  // The launcher's PATH decision feeding the app (review: a user copy used to
  // suppress the shim, and the app then ignored that copy).
  const launched = run(`${planted}:${sysBin}`, "x86_64");
  q8.push(["planted ~/.local/bin copy + launcher decision: shim appended, app takes the shim", nar(launched), true, join(shim, "qemu-system-x86_64")]);
  for (const [label, env, withR, want] of q8) {
    let r;
    try { r = await probeNarrowed(env, withR); } catch (e) { r = { got: "THREW " + e.message }; }
    check(label, r.got, want);
  }
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAIL:", failures.join("; "));
  process.exit(1);
}
if (!patchBin) {
  console.log("SKIP (launcher checks passed; patch checks need the compiled patch)");
  process.exit(3);
}
console.log("PASS");
