#!/usr/bin/env node
// Cowork's "install QEMU" hint must follow the host distro.
//
// WHY THIS EXISTS
// ---------------
// Upstream builds the command in the main bundle with no distro detection
// ("sudo apt install qemu-system-x86 ovmf [virtiofsd]", arm64: qemu-system-arm
// qemu-efi-aarch64), so Fedora/RHEL/Arch/openSUSE/NixOS users are told to run
// apt. patches/linux/fix_cowork_install_hint_linux wraps that one expression.
//
// This harness takes the REAL chunk of the extracted upstream bundle that holds
// the message, runs the compiled patch over it, checks apply / idempotency /
// node --check, then evaluates the REAL patched `installCommand` expression in
// `vm` with a fake `fs` serving different /etc/os-release contents, for both
// architectures, with and without upstream's virtiofsd entry. Debian, Ubuntu,
// unknown, missing and garbage os-release must equal upstream's original
// string byte for byte.
//
// Exit codes: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync,
  accessSync, constants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = join(ROOT, "patches", "linux", "fix_cowork_install_hint_linux");
const BUILD = join(ROOT, "tmp", "app.asar.contents", ".vite", "build");
const SKIP_EXIT = 3;

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) { pass++; return; }
  console.log(`  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  failures.push(label);
}
const countOf = (h, n) => h.split(n).length - 1;

try { accessSync(BIN, constants.X_OK); } catch {
  console.error(`SKIP: ${BIN.slice(ROOT.length + 1)} is not compiled (run: cd patches && make -j"$(nproc)")`);
  process.exit(SKIP_EXIT);
}
if (!existsSync(BUILD)) {
  console.error("SKIP: tmp/app.asar.contents is not extracted");
  process.exit(SKIP_EXIT);
}

// Find the real chunk that carries the message.
let chunk = null;
for (const f of readdirSync(BUILD)) {
  if (!/^index.*\.js$/.test(f)) continue;
  const s = readFileSync(join(BUILD, f), "latin1");
  if (s.includes("Cowork requires QEMU")) { chunk = { f, s }; break; }
}
if (!chunk) {
  console.log("FAIL: no chunk of the extracted bundle holds 'Cowork requires QEMU'");
  process.exit(1);
}

function run(file) {
  try {
    return { status: 0, out: execFileSync(BIN, [file], { encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { status: typeof e.status === "number" ? e.status : -1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "cdb-cw-hint-"));
try {
  const file = join(tmp, "index.js");
  writeFileSync(file, chunk.s, "latin1");

  console.log("apply");
  const r1 = run(file);
  check("patch applies (exit 0)", r1.status, 0);
  check("reports [OK] wrapped", /\[OK\] installCommand wrapped/.test(r1.out), true);
  const patched = readFileSync(file, "latin1");
  check("marker present exactly once", countOf(patched, "__cdbCwHintFam"), 1);
  check("source changed", patched !== chunk.s, true);

  console.log("idempotency");
  const r2 = run(file);
  check("second run exit 0", r2.status, 0);
  check("second run reports idempotent", /idempotent/.test(r2.out), true);
  check("second run leaves file byte-identical", readFileSync(file, "latin1"), patched);

  console.log("node --check");
  const chk = join(tmp, "chk.js");
  writeFileSync(chk, patched, "latin1");
  let ok = true;
  try { execFileSync(process.execPath, ["--check", chk], { stdio: "pipe" }); } catch { ok = false; }
  check("patched chunk passes node --check", ok, true);

  // Fail loud when the anchor is gone.
  const bad = join(tmp, "bad.js");
  writeFileSync(bad, chunk.s.replace("sudo apt install", "sudo apt-get install"), "latin1");
  check("missing anchor exits non-zero", run(bad).status !== 0, true);

  // ---- evaluate the REAL expressions
  const tail = ',unsupportedCode:"virtualization_tools_missing"';
  const pick = (src) => {
    const m = /\{installCommand:([\s\S]*?)\}\),unsupportedCode:"virtualization_tools_missing"/.exec(
      src.slice(src.indexOf("Cowork requires QEMU")));
    return m ? m[1] : null;
  };
  const pExpr = pick(patched);
  const oExpr = pick(chunk.s);
  check("found patched expression", !!pExpr, true);
  check("found original expression", !!oExpr, true);
  check("tail still follows", patched.includes("}),unsupportedCode:\"virtualization_tools_missing\"") , true);
  void tail;

  function evalExpr(expr, { osRelease, arch, virtiofs }) {
    const g = {};
    const sandbox = {
      process: { arch, platform: "linux" },
      require: (m) => {
        if (m !== "fs") throw new Error("unexpected require " + m);
        return {
          // osRelease: the /etc/os-release text, null (absent), or a map of
          // path -> text|null for the /usr/lib/os-release fallback rows.
          readFileSync: (p) => {
            const files = osRelease !== null && typeof osRelease === "object" ? osRelease : { "/etc/os-release": osRelease };
            if (p !== "/etc/os-release" && p !== "/usr/lib/os-release") throw new Error("unexpected path " + p);
            if (files[p] === null || files[p] === undefined) throw new Error("ENOENT");
            return files[p];
          },
        };
      },
      t: { virtiofsdPath: virtiofs ? "/usr/bin/virtiofsd" : null },
    };
    // globalThis inside the function is the sandbox global; reset per row.
    void g;
    return vm.runInNewContext(`(function(){return ${expr}})()`, vm.createContext(sandbox));
  }

  const OS = {
    debian: 'PRETTY_NAME="Debian GNU/Linux 12"\nID=debian\n',
    ubuntu: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n',
    fedora: "NAME=Fedora\nID=fedora\nVERSION_ID=43\n",
    rhel9: 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nID_LIKE="fedora"\n',
    rocky: 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n',
    arch: "NAME=\"Arch Linux\"\nID=arch\n",
    manjaro: "NAME=\"Manjaro Linux\"\nID=manjaro\nID_LIKE=arch\n",
    tumbleweed: 'NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
    nixos: "NAME=NixOS\nID=nixos\n",
    unknown: "NAME=Foo\nID=foolinux\n",
    // Image-based Fedora: dnf cannot install into the read-only base, so
    // upstream's text stays (rpm-ostree writes OSTREE_VERSION into os-release).
    silverblue: 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=43\nVARIANT="Silverblue"\nVARIANT_ID=silverblue\nOSTREE_VERSION=\'43.20251101.0\'\n',
    kinoite: 'NAME="Fedora Linux"\nID=fedora\nVARIANT_ID=kinoite\n',
    bazzite: 'NAME="Bazzite"\nID=bazzite\nID_LIKE="fedora"\nVARIANT_ID=bazzite-deck\nOSTREE_VERSION=\'43.20251101\'\n',
    // os-release(5): /usr/lib/os-release when /etc/os-release is missing.
    usrlibFedora: { "/etc/os-release": null, "/usr/lib/os-release": "NAME=Fedora\nID=fedora\nVERSION_ID=43\n" },
    garbage: "\u0000\u0001 not = an os-release \n===\n",
    empty: "",
  };

  // [row, osRelease, family expected as [x64, arm64] command prefix lists]
  const apt = (arch, v) =>
    "sudo apt install " + (arch === "arm64" ? "qemu-system-arm qemu-efi-aarch64" : "qemu-system-x86 ovmf") + (v ? "" : " virtiofsd");
  const dnf = (arch, v) => (pk) => `sudo dnf install ${pk[arch === "arm64" ? 1 : 0]}${v ? "" : " virtiofsd"}`;
  const EXP = {
    debian: (a, v) => apt(a, v),
    ubuntu: (a, v) => apt(a, v),
    fedora: (a, v) => dnf(a, v)(["qemu-system-x86 edk2-ovmf", "qemu-system-aarch64 edk2-aarch64"]),
    rhel9: (a, v) => dnf(a, v)(["qemu-kvm edk2-ovmf", "qemu-kvm edk2-aarch64"]),
    rocky: (a, v) => dnf(a, v)(["qemu-kvm edk2-ovmf", "qemu-kvm edk2-aarch64"]),
    arch: (a, v) => `sudo pacman -S ${a === "arm64" ? "qemu-system-aarch64 edk2-aarch64" : "qemu-system-x86 edk2-ovmf"}${v ? "" : " virtiofsd"}`,
    manjaro: (a, v) => `sudo pacman -S ${a === "arm64" ? "qemu-system-aarch64 edk2-aarch64" : "qemu-system-x86 edk2-ovmf"}${v ? "" : " virtiofsd"}`,
    tumbleweed: (a, v) => `sudo zypper install ${a === "arm64" ? "qemu-arm qemu-uefi-aarch64" : "qemu-x86 qemu-ovmf-x86_64"}${v ? "" : " virtiofsd"}`,
    nixos: (a, v) => `add qemu, OVMF${v ? "" : ", virtiofsd"} to environment.systemPackages`,
    unknown: (a, v) => apt(a, v),
    silverblue: (a, v) => apt(a, v),
    kinoite: (a, v) => apt(a, v),
    bazzite: (a, v) => apt(a, v),
    usrlibFedora: (a, v) => dnf(a, v)(["qemu-system-x86 edk2-ovmf", "qemu-system-aarch64 edk2-aarch64"]),
    garbage: (a, v) => apt(a, v),
    empty: (a, v) => apt(a, v),
    missing: (a, v) => apt(a, v),
  };

  console.log("rows (patched)");
  const rows = [...Object.keys(OS), "missing"];
  let n = 0;
  for (const row of rows) {
    for (const arch of ["x64", "arm64"]) {
      for (const virtiofs of [false, true]) {
        const osRelease = row === "missing" ? null : OS[row];
        const label = `${row}/${arch}/${virtiofs ? "virtiofsd-found" : "virtiofsd-missing"}`;
        const orig = evalExpr(oExpr, { osRelease, arch, virtiofs });
        check(`original ${label} is the apt string`, orig, apt(arch, virtiofs));
        const got = evalExpr(pExpr, { osRelease, arch, virtiofs });
        check(label, got, EXP[row](arch, virtiofs));
        if (["debian", "ubuntu", "unknown", "garbage", "empty", "missing", "silverblue", "kinoite", "bazzite"].includes(row)) {
          check(`${label} equals upstream byte for byte`, got, orig);
        }
        n++;
      }
    }
  }
  console.log(`  ${n} rows evaluated`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\nFAIL: ${failures.length} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\nPASS: ${pass} checks`);
