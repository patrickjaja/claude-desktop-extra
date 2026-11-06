#!/usr/bin/env node
/*
 * test-tpm-access-helper.mjs - the opt-in TPM access root helper
 * (packaging/udev/cdb-tpm-access), run for real against a temp root.
 *
 * WHY THIS EXISTS
 * ---------------
 * Settings -> Extra -> Cowork (Linux) runs cdb-tpm-access through pkexec. As
 * root it links a udev uaccess rule for /dev/tpmrm* into /etc/udev/rules.d, or
 * removes that link. Removing the rule alone does not take the ACL away: udev
 * keeps the tag in TAGS until reboot and logind re-applies the seat ACL from it
 * (measured on Arch, systemd, 2026-11-06: TAGS=:uaccess:seat:systemd:,
 * CURRENT_TAGS=:systemd:, user ACL still there after relogin). So disable
 * clears the node's extended ACL with setfacl -b - but only when CURRENT_TAGS
 * shows no rule still grants uaccess. What can break a user here:
 *   - an ACL cleared that another rule grants (a working setup broken);
 *   - disable reported done while the ACL stays (the app stays keyed);
 *   - the link removed and then the run failing for a missing setfacl;
 *   - anything but tpmrm char devices touched.
 *
 * Same method as test-kvm-access-helper.mjs: a copy whose fixed path constants
 * point into a temp root (each defined exactly once), stub id / stat / udevadm /
 * setfacl that log their arguments, fake device nodes that are links to
 * /dev/null ([ -c ] follows them). The unprivileged refusals and the rule-path
 * predicate stay in scripts/tests/core/test-cu-status-main.mjs.
 *
 * Usage: node scripts/tests/linux/test-tpm-access-helper.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, symlinkSync, rmSync, existsSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import net from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UDEV = join(ROOT, "packaging", "udev");
const HELPER = join(UDEV, "cdb-tpm-access");
const RULE = "70-claude-desktop-extra-tpm.rules";

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  fail++;
  console.error("  FAIL " + label + (extra !== undefined ? "  -> " + extra : ""));
}
function section(t) { console.log("\n" + t); }
const J = (v) => JSON.stringify(v);

if (typeof process.getuid === "function" && process.getuid() === 0) {
  console.log("SKIP: running as root (the helper copy must never reach the real /etc or /dev)");
  process.exit(3);
}

const htext = readFileSync(HELPER, "utf8");
const ruleFile = readFileSync(join(UDEV, RULE), "utf8");
const base = realpathSync(mkdtempSync(join(tmpdir(), "cdb-tpm-")));
const R = join(base, "root");
const PKG_DIR = join(R, "usr", "lib", "claude-desktop", "resources", "linux-udev");
const P = {
  ETC_UDEV: join(R, "etc", "udev"),
  RULES_DIR: join(R, "etc", "udev", "rules.d"),
  NIXOS_MARKER: join(R, "etc", "NIXOS"),
  UDEV_CONTROL: join(R, "run", "udev", "control"),
  DEV_DIR: join(R, "dev"),
};
const ORIG = { ETC_UDEV: "/etc/udev", RULES_DIR: "/etc/udev/rules.d", NIXOS_MARKER: "/etc/NIXOS", UDEV_CONTROL: "/run/udev/control", DEV_DIR: "/dev" };
const STUBS = join(base, "stubs");
const SYS = join(base, "sys");
const LOG = join(base, "tools.log");
const MARKERS = ["/run/systemd/container", "/.dockerenv", "/run/.containerenv", "/.flatpak-info"];
for (const d of [PKG_DIR, P.RULES_DIR, P.DEV_DIR, dirname(P.UDEV_CONTROL), STUBS, SYS]) mkdirSync(d, { recursive: true });

const stub = (name, body) => { const f = join(STUBS, name); writeFileSync(f, "#!/bin/sh\n" + body); chmodSync(f, 0o755); };
stub("id", 'printf \'%s\\n\' "${FAKE_UID-0}"\n');
stub("udevadm", 'printf \'udevadm %s\\n\' "$*" >> "$FAKE_LOG"\n' +
  'if [ "$1" = info ]; then echo TAGS=:seat:systemd:uaccess:; c=${FAKE_CURRENT_TAGS-:systemd:}; [ "$c" = none ] || echo "CURRENT_TAGS=$c"; fi\n' +
  'exit "${FAKE_UDEVADM_RC-0}"\n');
const SETFACL_STUB = 'printf \'setfacl %s\\n\' "$*" >> "$FAKE_LOG"\nexit "${FAKE_SETFACL_RC-0}"\n';
stub("setfacl", SETFACL_STUB);
stub("stat", [
  'if [ "$1" = -c ] && [ "$2" = "%u %a" ]; then',
  '  [ -e "$4" ] || exit 1',
  '  if [ -d "$4" ]; then echo "0 755"; else echo "0 644"; fi',
  '  exit 0',
  'fi',
  'exec stat "$@"',
  "",
].join("\n"));
for (const t of ["readlink", "ln", "rm", "mkdir", "mv", "cat"]) {
  const real = ["/usr/bin", "/bin"].map((d) => d + "/" + t).find((f) => existsSync(f));
  if (real) symlinkSync(real, join(SYS, t));
}

section("helper copy: every fixed path constant re-pointed, each defined exactly once");
let fake = htext;
const once = (re, what, repl) => {
  const n = (fake.match(new RegExp(re.source, "gm")) || []).length;
  ok(n === 1, what + " defined exactly once", n);
  fake = fake.replace(new RegExp(re.source, "m"), repl);
};
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
for (const k of Object.keys(ORIG)) once(new RegExp("^" + k + "=" + esc(ORIG[k]) + "$"), k, k + "=" + P[k]);
once(/^PKG_SRC=\/usr\/lib\/claude-desktop\/resources\/linux-udev\/\$RULE$/, "PKG_SRC", "PKG_SRC=" + PKG_DIR + "/$RULE");
// Tool dirs: stubs, then links to the real tools the helper needs (setfacl only as the stub).
once(/^TOOL_DIRS='\/usr\/bin\n\/bin\n\/usr\/sbin\n\/sbin'$/, "TOOL_DIRS", "TOOL_DIRS='" + STUBS + "\n" + SYS + "'");
once(/^CONTAINER_MARKERS='[^']*'$/, "CONTAINER_MARKERS", "CONTAINER_MARKERS='" + MARKERS.map((m) => R + m).join("\n") + "'");
const code = fake.split(R + "/").join("<fake>:").split("\n").filter((l) => !l.startsWith("#") && !/fail [0-9] /.test(l) && !/2>\/dev\/null/.test(l)).join("\n");
ok(!/\/run\/udev|\/etc\/|(^|[^\w])\/dev\//m.test(code), "the copy's code (not comments or messages) names no host path");

const FHELPER = join(PKG_DIR, "cdb-tpm-access");
const SRC = join(PKG_DIR, RULE);
const LINK = join(P.RULES_DIR, RULE);
writeFileSync(FHELPER, fake); chmodSync(FHELPER, 0o755);
writeFileSync(SRC, ruleFile);
const server = net.createServer();
await new Promise((res, rej) => { server.once("error", rej); server.listen(P.UDEV_CONTROL, res); });

const run = (args, env = {}) => {
  writeFileSync(LOG, "");
  const r = spawnSync("/bin/sh", [FHELPER, ...args], { encoding: "utf8", env: { ...process.env, FAKE_LOG: LOG, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: readFileSync(LOG, "utf8") };
};
const target = (p) => { try { return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : "file"; } catch { return null; } };
const T0 = join(P.DEV_DIR, "tpmrm0");
const T1 = join(P.DEV_DIR, "tpmrm1");
const APPLY = "udevadm control --reload\nudevadm trigger --action=change --subsystem-match=tpmrm\nudevadm settle --timeout=10\n";
const info = (n) => "udevadm info --query=property --name=" + n + "\n";
const setf = (n) => "setfacl -b -- " + n + "\n";

section("enable is unchanged: link, reload, trigger tpmrm, no ACL step");
{
  symlinkSync("/dev/null", T0);
  let r = run(["enable"]);
  ok(r.status === 0 && r.stdout === "cdb-tpm-access: enabled (" + LINK + " -> " + SRC + ")\n" && target(LINK) === SRC && r.log === APPLY, "enabled", J(r));
  r = run(["enable"]);
  ok(r.status === 0 && r.stdout === "cdb-tpm-access: already enabled\n" && r.log === APPLY, "already enabled", J(r));
}

section("disable clears the tpmrm ACL when no rule still grants uaccess");
{
  let r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-tpm-access: disabled (acl cleared: " + T0 + ")\n" && target(LINK) === null &&
    r.log === APPLY + info(T0) + setf(T0), "link removed, reload + trigger, then CURRENT_TAGS checked and setfacl -b", J(r));
  run(["enable"]);
  r = run(["disable"], { FAKE_CURRENT_TAGS: ":seat:systemd:uaccess:" });
  ok(r.status === 0 && r.stdout === "cdb-tpm-access: disabled (acl kept, another udev rule grants it: " + T0 + ")\n" && r.log === APPLY + info(T0),
    "another rule still tags uaccess: ACL kept, no setfacl", J(r));
  r = run(["disable"], { FAKE_CURRENT_TAGS: "none" });
  ok(r.status === 0 && r.stdout === "cdb-tpm-access: already disabled (acl kept, udev reports no CURRENT_TAGS: " + T0 + ")\n" && r.log === APPLY + info(T0),
    "udev without CURRENT_TAGS: ACL kept, said so", J(r));
  r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-tpm-access: already disabled (acl cleared: " + T0 + ")\n" && r.log === APPLY + info(T0) + setf(T0),
    "already disabled still clears an ACL left by an earlier disable", J(r));
  // Two nodes; a non-device tpmrm entry and tpm0 are never touched.
  symlinkSync("/dev/null", T1);
  writeFileSync(join(P.DEV_DIR, "tpmrm9"), "");
  symlinkSync("/dev/null", join(P.DEV_DIR, "tpm0"));
  r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-tpm-access: already disabled (acl cleared: " + T0 + "; acl cleared: " + T1 + ")\n" &&
    r.log === APPLY + info(T0) + setf(T0) + info(T1) + setf(T1), "each tpmrm char device, nothing else (not tpm0, not a regular file)", J(r));
  rmSync(T1); rmSync(join(P.DEV_DIR, "tpmrm9")); rmSync(join(P.DEV_DIR, "tpm0"));
  run(["enable"]);
  r = run(["disable"], { FAKE_SETFACL_RC: "1" });
  ok(r.status === 4 && r.stdout === "" && /^cdb-tpm-access: disabled, but setfacl -b .*tpmrm0 failed \(the ACL stays until reboot\)$/m.test(r.stderr),
    "setfacl fails: exit 4, says so", J(r));
}

section("no setfacl: refused before the link changes; fine when there is no tpmrm node");
{
  run(["enable"]);
  rmSync(join(STUBS, "setfacl"));
  let r = run(["disable"]);
  ok(r.status === 4 && r.stdout === "" && /missing tool: setfacl \(install the acl package\); nothing changed/.test(r.stderr) &&
    target(LINK) === SRC && r.log === "", "node present, no setfacl: exit 4, link kept, no tool run", J(r));
  rmSync(T0);
  r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-tpm-access: disabled\n" && target(LINK) === null && r.log === APPLY, "no tpmrm node: disabled without an ACL step", J(r));
  stub("setfacl", SETFACL_STUB);
}

section("refusals still come first");
{
  symlinkSync("/dev/null", T0);
  run(["enable"]);
  let r = run(["disable"], { FAKE_UID: "1000" });
  ok(r.status === 1 && target(LINK) === SRC && r.log === "", "not root: exit 1, nothing changed", J(r));
  writeFileSync(P.NIXOS_MARKER, "");
  r = run(["disable"]);
  ok(r.status === 4 && /tpmAccess\.enable = true;/.test(r.stderr) && target(LINK) === SRC && r.log === "", "NixOS: exit 4, nothing changed", J(r));
  rmSync(P.NIXOS_MARKER);
  rmSync(LINK); symlinkSync("/etc/elsewhere.rules", LINK);
  r = run(["disable"]);
  ok(r.status === 4 && target(LINK) === "/etc/elsewhere.rules" && r.log === "", "foreign link: exit 4, no ACL touched", J(r));
  rmSync(LINK);
  await new Promise((res) => server.close(res));
  rmSync(P.UDEV_CONTROL, { force: true });
  r = run(["disable"]);
  ok(r.status === 3 && /udev is not running here/.test(r.stderr) && r.log === "", "no udev: exit 3, no ACL touched", J(r));
}

rmSync(base, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
