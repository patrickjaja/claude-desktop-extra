#!/usr/bin/env node
// RHEL-family Cowork: the launcher puts our qemu shim dir on PATH only when the
// app's own qemu lookup would fail and RHEL's qemu-kvm is installed.
//
// WHY THIS EXISTS
// ---------------
// Upstream's Cowork probe walks process.env.PATH for `qemu-system-x86_64`
// (`qemu-system-aarch64` on arm64), checking X_OK on each `<dir>/<name>`; the
// native cowork-linux-helper then execs that same name. RHEL 9 / Rocky / Alma
// ship QEMU only as /usr/libexec/qemu-kvm (package qemu-kvm-core), so the probe
// reports "Cowork requires QEMU" even with qemu-kvm installed. Booted
// 2026-09-23 on rockylinux:9 (qemu-kvm 10.1.0-17.el9_8.5) through a
// `qemu-system-x86_64 -> /usr/libexec/qemu-kvm` symlink: the helper's exact
// command line (-machine q35,accel=kvm, vhost-vsock-pci, vhost-user-fs-pci,
// memory-backend-memfd, -sandbox on) runs unchanged and the guest reports ready.
//
// The rpm ships /usr/lib/claude-desktop/qemu-shim/qemu-system-<arch> symlinks.
// The launcher appends that dir to PATH, and only when all of these hold:
//   - no executable qemu-system-<arch> is on PATH (a real QEMU always wins,
//     so Fedora/Arch/Debian behavior is unchanged),
//   - /usr/libexec/qemu-kvm is executable,
//   - the shim exists (only the rpm ships it).
//
// This harness extracts the real function from the launcher and runs it
// against scratch directories, and pins the rpm spec + the launcher call site.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

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
check("real qemu-system-x86_64 on PATH -> unchanged",
  run(`${realQemuBin}:${base}`, "x86_64"), `${realQemuBin}:${base}`);
check("real qemu-system-aarch64 on PATH -> unchanged",
  run(`${realQemuBin}:${base}`, "aarch64"), `${realQemuBin}:${base}`);
check("non-executable qemu-system-x86_64 on PATH does not count -> shim appended",
  run(`${noExecBin}:${base}`, "x86_64"), `${noExecBin}:${base}:${shim}`);
check("no /usr/libexec/qemu-kvm -> unchanged",
  run(base, "x86_64", join(scratch, "missing", "qemu-kvm")), base);
check("shim dir not installed (non-rpm package) -> unchanged",
  run(base, "x86_64", qemuKvm, join(scratch, "no-shim")), base);
check("unsupported arch -> unchanged", run(base, "riscv64"), base);
check("shim already on PATH (relaunch) -> unchanged",
  run(`${base}:${shim}`, "x86_64"), `${base}:${shim}`);
check("empty PATH entries are skipped, shim appended",
  run(`::${base}`, "x86_64"), `::${base}:${shim}`);

console.log("Q2: launcher call site");
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

console.log("Q3: rpm spec ships the shim");
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

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAIL:", failures.join("; "));
  process.exit(1);
}
console.log("PASS");
