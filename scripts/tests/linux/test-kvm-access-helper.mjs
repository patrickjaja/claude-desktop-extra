#!/usr/bin/env node
/*
 * test-kvm-access-helper.mjs - the opt-in KVM access root helper
 * (packaging/udev/cdb-kvm-access) and the files it links.
 *
 * WHY THIS EXISTS
 * ---------------
 * Local Cowork's QEMU VM needs /dev/kvm and /dev/vhost-vsock. Settings -> Extra
 * -> Cowork (Linux) can run cdb-kvm-access through pkexec: as root it links a
 * udev uaccess rule into /etc/udev/rules.d and a modules-load file into
 * /etc/modules-load.d, loads vhost_vsock and re-triggers udev. What can break a
 * user here:
 *   - a link into a tree that is not a package install (it dangles once the tree
 *     is deleted; whoever recreates the path writes a root udev rule);
 *   - a foreign file or link in either admin directory overwritten or removed,
 *     or one link changed before the other turned out to be foreign;
 *   - a rule other than the shipped one linked (a wider ACL than documented);
 *   - an exit code or output line that lies (main maps them to the page).
 *
 * The helper runs for real (/bin/sh) on a copy whose fixed path constants are
 * re-pointed into a temp root: the package dir, /etc/udev, /etc/udev/rules.d,
 * /etc/modules-load.d, /etc/NIXOS, /run/udev/control (a real unix socket), the
 * container markers, and the tool directories (a stub dir first: id, stat,
 * modprobe and udevadm are fakes that log their arguments; ln, rm, mv, mkdir,
 * cat and readlink are the system's). Each rewritten constant must occur exactly
 * once, so a new hard-coded path makes this harness fail instead of touching
 * the host. Refuses to run as root.
 *
 * Usage: node scripts/tests/linux/test-kvm-access-helper.mjs
 */
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, symlinkSync, rmSync,
  existsSync, realpathSync, statSync, lstatSync, readlinkSync, readdirSync, renameSync, appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import net from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UDEV = join(ROOT, "packaging", "udev");
const HELPER = join(UDEV, "cdb-kvm-access");
const TPM_HELPER = join(UDEV, "cdb-tpm-access");
const RULE = "70-claude-desktop-extra-kvm.rules";
const CONF = "claude-desktop-extra-vsock.conf";
const POLICY = "io.github.patrickjaja.claude-desktop-extra.kvm-access.policy";
const TPM_RULE_PATHS = join(ROOT, "scripts", "tests", "fixtures", "tpm-rule-paths.tsv");

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
  console.log("SKIP: running as root (the helper copy must never reach the real /etc)");
  process.exit(3);
}
for (const f of [HELPER, join(UDEV, RULE), join(UDEV, CONF), join(UDEV, POLICY)]) {
  if (!existsSync(f)) { console.error("FAIL missing " + f); process.exit(1); }
}

const htext = readFileSync(HELPER, "utf8");
const ruleFile = readFileSync(join(UDEV, RULE), "utf8");
const confFile = readFileSync(join(UDEV, CONF), "utf8");

// --- fake root ------------------------------------------------------------------
const base = realpathSync(mkdtempSync(join(tmpdir(), "cdb-kvm-")));
const R = join(base, "root");
const P = {
  PKG_DIR: join(R, "usr", "lib", "claude-desktop", "resources", "linux-udev"),
  ETC_DIR: join(R, "etc"),
  ETC_UDEV: join(R, "etc", "udev"),
  RULES_DIR: join(R, "etc", "udev", "rules.d"),
  MODULES_DIR: join(R, "etc", "modules-load.d"),
  NIXOS_MARKER: join(R, "etc", "NIXOS"),
  UDEV_CONTROL: join(R, "run", "udev", "control"),
  DEV_DIR: join(R, "dev"),
};
const ORIG = {
  PKG_DIR: "/usr/lib/claude-desktop/resources/linux-udev",
  ETC_DIR: "/etc",
  ETC_UDEV: "/etc/udev",
  RULES_DIR: "/etc/udev/rules.d",
  MODULES_DIR: "/etc/modules-load.d",
  NIXOS_MARKER: "/etc/NIXOS",
  UDEV_CONTROL: "/run/udev/control",
  DEV_DIR: "/dev",
};
const STUBS = join(base, "stubs");
const LOG = join(base, "tools.log");
const MARKERS = ["/run/systemd/container", "/.dockerenv", "/run/.containerenv", "/.flatpak-info"];
for (const d of [P.DEV_DIR, P.PKG_DIR, P.RULES_DIR, P.MODULES_DIR, dirname(P.UDEV_CONTROL), STUBS, join(R, "run", "systemd")]) mkdirSync(d, { recursive: true });

// Stub tools. The helper resets PATH, so the stubs reach real tools by name.
const stub = (name, body) => { const f = join(STUBS, name); writeFileSync(f, "#!/bin/sh\n" + body); chmodSync(f, 0o755); };
stub("id", 'printf \'%s\\n\' "${FAKE_UID-0}"\n');
stub("modprobe", 'printf \'modprobe %s\\n\' "$*" >> "$FAKE_LOG"\n' +
  '[ -z "${MODPROBE_OPTIONS+x}" ] || printf \'MODPROBE_OPTIONS=%s\\n\' "$MODPROBE_OPTIONS" >> "$FAKE_LOG"\n' +
  'exit "${FAKE_MODPROBE_RC-0}"\n');
// readlink -- <p> fails for <p> = FAKE_READLINK_FAIL (a link that cannot be read); else the real one.
stub("readlink", 'for a; do last=$a; done\n' +
  'if [ "$1" = -- ] && [ -n "${FAKE_READLINK_FAIL-}" ] && [ "$last" = "$FAKE_READLINK_FAIL" ]; then exit 1; fi\n' +
  'exec readlink "$@"\n');
// udevadm info --query=property prints sticky TAGS and FAKE_CURRENT_TAGS (default :systemd:;
// "none" = an old udev without CURRENT_TAGS). setfacl only logs.
stub("udevadm", 'printf \'udevadm %s\\n\' "$*" >> "$FAKE_LOG"\n' +
  'if [ "$1" = info ]; then echo TAGS=:seat:systemd:uaccess:; c=${FAKE_CURRENT_TAGS-:systemd:}; [ "$c" = none ] || echo "CURRENT_TAGS=$c"; fi\n' +
  'exit "${FAKE_UDEVADM_RC-0}"\n');
stub("setfacl", 'printf \'setfacl %s\\n\' "$*" >> "$FAKE_LOG"\nexit "${FAKE_SETFACL_RC-0}"\n');
// stat -c '%u %a' -- <p>: root-owned, 755/644, unless <p> is listed in FAKE_UNSAFE.
stub("stat", [
  'if [ "$1" = -c ] && [ "$2" = "%u %a" ]; then',
  '  [ -e "$4" ] || exit 1',
  '  case " ${FAKE_UNSAFE-} " in *" $4 "*) echo "1000 664"; exit 0 ;; esac',
  '  if [ -d "$4" ]; then echo "0 755"; else echo "0 644"; fi',
  '  exit 0',
  'fi',
  'exec stat "$@"',
  "",
].join("\n"));

section("helper copy: every fixed path constant re-pointed, each defined exactly once");
let fake = htext;
const once = (re, what, repl) => {
  const n = (fake.match(new RegExp(re.source, "gm")) || []).length;
  ok(n === 1, what + " defined exactly once", n);
  fake = fake.replace(new RegExp(re.source, "m"), repl);
};
for (const k of Object.keys(ORIG)) {
  const re = new RegExp("^" + k + "=" + ORIG[k].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "$");
  once(re, k + "=" + ORIG[k], k + "=" + P[k]);
}
once(/^TOOL_DIRS='\/usr\/bin\n\/bin\n\/usr\/sbin\n\/sbin'$/, "TOOL_DIRS", "TOOL_DIRS='" + STUBS + "\n/usr/bin\n/bin\n/usr/sbin\n/sbin'");
once(/^CONTAINER_MARKERS='[^']*'$/, "CONTAINER_MARKERS", "CONTAINER_MARKERS='" + MARKERS.map((m) => R + m).join("\n") + "'");
// No other assignment of an absolute host path survives in the copy.
const hostAssign = fake.split("\n").filter((l) => /^[A-Z_]+=['"]?\/(etc|run|usr|lib|dev|var)\//.test(l) && !l.startsWith("PATH="));
ok(hostAssign.length === 0, "no other constant names a host path", J(hostAssign));
ok(!/\/run\/udev\/control|\/etc\/udev\/rules\.d|\/etc\/modules-load\.d/.test(fake.split(R + "/").join("<fake>:").split("\n").filter((l) => !l.startsWith("#") && !/fail [0-9] /.test(l)).join("\n")),
  "the copy's code (not comments or messages) names no admin path");

const FHELPER = join(P.PKG_DIR, "cdb-kvm-access");
writeFileSync(FHELPER, fake); chmodSync(FHELPER, 0o755);
const SRC = join(P.PKG_DIR, RULE);
const MSRC = join(P.PKG_DIR, CONF);
const LINK = join(P.RULES_DIR, RULE);
const MLINK = join(P.MODULES_DIR, CONF);
const putFiles = () => { writeFileSync(SRC, ruleFile); writeFileSync(MSRC, confFile); chmodSync(SRC, 0o644); chmodSync(MSRC, 0o644); };
putFiles();

const server = net.createServer();
await new Promise((res, rej) => { server.once("error", rej); server.listen(P.UDEV_CONTROL, res); });

const run = (args, env = {}, helper = FHELPER) => {
  writeFileSync(LOG, "");
  const r = spawnSync("/bin/sh", [helper, ...args], { encoding: "utf8", env: { ...process.env, FAKE_LOG: LOG, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: readFileSync(LOG, "utf8") };
};
const target = (p) => { try { return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : "file"; } catch { return null; } };
const clean = () => { rmSync(LINK, { force: true }); rmSync(MLINK, { force: true }); };
const stray = () => [...readdirSync(P.RULES_DIR), ...readdirSync(P.MODULES_DIR)].filter((n) => n.includes(".tmp."));
const ENABLED = "cdb-kvm-access: enabled (" + LINK + " -> " + SRC + "; " + MLINK + " -> " + MSRC + ")\n";
const REPOINTED = "cdb-kvm-access: re-pointed (" + LINK + " -> " + SRC + "; " + MLINK + " -> " + MSRC + ")\n";
const TRIGGER = "udevadm trigger --action=change --subsystem-match=misc --sysname-match=kvm --sysname-match=vhost-vsock";
const APPLY = "modprobe vhost_vsock\nudevadm control --reload\n" + TRIGGER + "\nudevadm settle --timeout=10\n";
const RELOAD = "udevadm control --reload\n" + TRIGGER + "\nudevadm settle --timeout=10\n";
const nix = (name, file) => "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-" + name + "/lib/claude-desktop/resources/linux-udev/" + file;

section("usage and status (no root needed)");
{
  for (const args of [[], ["bogus"], ["enable", "extra"], ["--help"]]) {
    const r = run(args);
    ok(r.status === 2 && r.stdout === "" && r.stderr === "cdb-kvm-access: usage: cdb-kvm-access enable|disable|status\n" && r.log === "",
      "usage " + J(args) + ": exit 2, one stderr line", J(r));
  }
  let r = run(["status"], { FAKE_UID: "1000" });
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: status rule=absent modules=absent\n" && r.stderr === "" && r.log === "",
    "status, not root, nothing linked: absent/absent, exit 0, no tool run", J(r));
}

section("not root");
{
  const r = run(["enable"], { FAKE_UID: "1000" });
  ok(r.status === 1 && r.stdout === "" && /must run as root/.test(r.stderr) && target(LINK) === null && target(MLINK) === null && r.log === "",
    "enable as a user: exit 1, nothing linked", J(r));
}

section("enable: absent -> enabled, then already enabled");
{
  clean();
  let r = run(["enable"]);
  ok(r.status === 0 && r.stdout === ENABLED && r.stderr === "", "enabled: exit 0, the C1 line", J(r));
  ok(target(LINK) === SRC && target(MLINK) === MSRC, "both links point at the package files (raw target)", J([target(LINK), target(MLINK)]));
  ok(r.log === APPLY, "modprobe vhost_vsock, then reload, trigger kvm + vhost-vsock, settle", J(r.log));
  r = run(["status"], { FAKE_UID: "1000" });
  ok(r.stdout === "cdb-kvm-access: status rule=current modules=current\n" && r.status === 0, "status: current/current", J(r));
  r = run(["enable"]);
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: already enabled\n" && r.log === APPLY, "already enabled: exit 0, still applies (ACL reaches this seat)", J(r));
}

section("enable: stale links are re-pointed atomically");
{
  clean();
  symlinkSync(nix("cdb-old", RULE), LINK);
  symlinkSync(nix("cdb-old", CONF), MLINK);
  let r = run(["status"], { FAKE_UID: "1000" });
  ok(r.stdout === "cdb-kvm-access: status rule=stale-dangling modules=stale-dangling\n", "status: stale-dangling (Nix store targets gone, not in effect)", J(r));
  r = run(["enable"]);
  ok(r.status === 0 && r.stdout === REPOINTED && target(LINK) === SRC && target(MLINK) === MSRC && stray().length === 0,
    "re-pointed: both now ours, no temp link left", J([r, stray()]));
  rmSync(MLINK);
  rmSync(LINK); symlinkSync(nix("cdb-old", RULE), LINK);
  r = run(["enable"]);
  ok(r.status === 0 && r.stdout === ENABLED && target(LINK) === SRC && target(MLINK) === MSRC, "stale rule + absent conf: enabled, both ours", J(r));
}

section("enable: a foreign entry in either directory changes nothing");
{
  const cases = [
    ["conf link to another file, rule absent", () => { symlinkSync("/etc/elsewhere.conf", MLINK); }, "modules=foreign", LINK],
    ["regular file at the rule path, conf absent", () => { writeFileSync(LINK, "x\n"); }, "rule=foreign", MLINK],
    ["rule link pointing at our conf (wrong file)", () => { symlinkSync(MSRC, LINK); }, "rule=foreign", MLINK],
    ["conf link to the TPM rule path", () => { symlinkSync("/usr/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules", MLINK); }, "modules=foreign", LINK],
    ["rule link to a build tree under /tmp", () => { symlinkSync("/tmp/cdb-tree/resources/linux-udev/" + RULE, LINK); }, "rule=foreign", MLINK],
  ];
  for (const [what, setup, st, other] of cases) {
    clean(); setup();
    const before = [target(LINK), target(MLINK)];
    let r = run(["status"], { FAKE_UID: "1000" });
    ok(r.status === 0 && r.stdout.includes(st), "status shows " + st + ": " + what, J(r));
    r = run(["enable"]);
    ok(r.status === 4 && r.stdout === "" && /left alone: .* is not a claude-desktop-extra link \(nothing changed\)/.test(r.stderr) &&
      J([target(LINK), target(MLINK)]) === J(before) && target(other) === null && r.log === "",
      "enable, " + what + ": exit 4, the other link not created, no tool run", J([r, before]));
    r = run(["disable"]);
    ok(r.status === 4 && r.stdout === "" && J([target(LINK), target(MLINK)]) === J(before) && r.log === "",
      "disable, " + what + ": exit 4, nothing removed", J(r));
  }
  // Foreign conf next to OUR rule link: disable must not remove ours either.
  clean(); symlinkSync(SRC, LINK); symlinkSync("/etc/elsewhere.conf", MLINK);
  const r = run(["disable"]);
  ok(r.status === 4 && target(LINK) === SRC && target(MLINK) === "/etc/elsewhere.conf", "disable with one foreign link keeps our other link", J(r));
}

section("disable");
{
  clean();
  run(["enable"]);
  let r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: disabled\n" && target(LINK) === null && target(MLINK) === null && r.log === RELOAD,
    "disabled: both removed, reload + trigger, module never unloaded", J(r));
  r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: already disabled\n" && r.log === RELOAD, "already disabled: exit 0, udev re-applied (no vhost-vsock node: no ACL step)", J(r));
  symlinkSync(nix("cdb-old", RULE), LINK);
  r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: disabled\n" && target(LINK) === null, "a stale rule link alone: removed", J(r));
  ok(existsSync(SRC) && existsSync(MSRC) && existsSync(P.RULES_DIR) && existsSync(P.MODULES_DIR), "package files and admin dirs untouched");
}

section("modprobe failure -> exit 6, links stay, udev still applied");
{
  clean();
  const r = run(["enable"], { FAKE_MODPROBE_RC: "1" });
  ok(r.status === 6 && r.stdout === "" &&
    r.stderr === "cdb-kvm-access: enabled (" + LINK + " -> " + SRC + "; " + MLINK + " -> " + MSRC + "), but modprobe vhost_vsock failed: this kernel may lack vhost-vsock (local Cowork needs it)\n",
    "exit 6, one stderr line, nothing on stdout", J(r));
  ok(target(LINK) === SRC && target(MLINK) === MSRC && r.log === APPLY, "both links in place, reload + trigger still ran", J(r.log));
  clean();
}

section("enable creates a missing /etc/modules-load.d");
{
  clean(); rmSync(P.MODULES_DIR, { recursive: true });
  const r = run(["enable"]);
  ok(r.status === 0 && r.stdout === ENABLED && statSync(P.MODULES_DIR).isDirectory() && target(MLINK) === MSRC, "dir created, link made", J(r));
  clean();
}

section("R1: partial enable/disable still applies udev; MODPROBE_OPTIONS dropped; unreadable link; dangling");
{
  // 1. The conf link cannot be made (dir not writable): the rule link stays and udev is applied.
  clean(); chmodSync(P.MODULES_DIR, 0o555);
  let r = run(["enable"]);
  ok(r.status === 4 && r.stdout === "" &&
    r.stderr.split("\n").slice(-2)[0] + "\n" === "cdb-kvm-access: cannot create the link " + MLINK + " (already done and applied: " + LINK + ")\n" &&
    target(LINK) === SRC && target(MLINK) === null && r.log === RELOAD,
    "partial enable: exit 4 naming the done link, reload + trigger ran, no modprobe", J(r));
  chmodSync(P.MODULES_DIR, 0o755);
  run(["enable"]);
  chmodSync(P.MODULES_DIR, 0o555);
  r = run(["disable"]);
  ok(r.status === 4 && r.stderr.split("\n").slice(-2)[0] + "\n" === "cdb-kvm-access: cannot remove the link " + MLINK + " (already done and applied: " + LINK + ")\n" &&
    target(LINK) === null && target(MLINK) === MSRC && r.log === RELOAD, "partial disable: exit 4, removal applied", J(r));
  chmodSync(P.MODULES_DIR, 0o755);
  // Nothing done yet when the first op fails: no udev run.
  clean(); chmodSync(P.RULES_DIR, 0o555);
  r = run(["enable"]);
  ok(r.status === 4 && r.stderr.split("\n").slice(-2)[0] + "\n" === "cdb-kvm-access: cannot create the link " + LINK + "\n" && r.log === "" && target(MLINK) === null,
    "first link fails: exit 4, nothing applied", J(r));
  chmodSync(P.RULES_DIR, 0o755);
  // 2. MODPROBE_OPTIONS from the caller never reaches modprobe.
  clean();
  r = run(["enable"], { MODPROBE_OPTIONS: "-v --ignore-install" });
  ok(r.status === 0 && r.log === APPLY, "MODPROBE_OPTIONS unset before modprobe", J(r.log));
  // 3. A link that cannot be read: status says foreign (exit 0); enable/disable refuse, nothing changed.
  r = run(["status"], { FAKE_UID: "1000", FAKE_READLINK_FAIL: MLINK });
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: status rule=current modules=foreign\n", "unreadable link: status foreign, exit 0", J(r));
  r = run(["disable"], { FAKE_READLINK_FAIL: MLINK });
  ok(r.status === 4 && target(LINK) === SRC && target(MLINK) === MSRC && r.log === "", "unreadable link: disable exit 4, nothing removed", J(r));
  // 4. Dangling: our own target gone -> current-dangling; another install's existing file -> stale.
  rmSync(SRC);
  r = run(["status"], { FAKE_UID: "1000" });
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: status rule=current-dangling modules=current\n", "own rule file gone: current-dangling", J(r));
  r = run(["enable"]);
  ok(r.status === 5 && target(LINK) === SRC, "enable without its own rule file: exit 5, link untouched", J(r));
  putFiles();
  const other = join(base, "other", "resources", "linux-udev");
  mkdirSync(other, { recursive: true });
  const oh = join(other, "cdb-kvm-access");
  writeFileSync(oh, fake); chmodSync(oh, 0o755);
  r = run(["status"], { FAKE_UID: "1000" }, oh);
  ok(r.stdout === "cdb-kvm-access: status rule=stale modules=stale\n", "links to another install's existing files: stale (in effect)", J(r));
  // enable and disable treat dangling links as ours.
  clean(); symlinkSync(nix("cdb-gone", RULE), LINK); symlinkSync(nix("cdb-gone", CONF), MLINK);
  r = run(["enable"]);
  ok(r.status === 0 && r.stdout === REPOINTED && target(LINK) === SRC && target(MLINK) === MSRC, "enable re-points stale-dangling links", J(r));
  clean(); symlinkSync(nix("cdb-gone", RULE), LINK);
  r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: disabled\n" && target(LINK) === null, "disable removes a stale-dangling link", J(r));
  // 5. /etc itself a symlink: left alone.
  clean();
  renameSync(P.ETC_DIR, P.ETC_DIR + ".real"); symlinkSync(P.ETC_DIR + ".real", P.ETC_DIR);
  r = run(["enable"]);
  ok(r.status === 4 && r.stderr === "cdb-kvm-access: left alone: " + P.ETC_DIR + " is a symlink\n" && r.log === "" &&
    target(LINK) === null && target(MLINK) === null, "/etc a symlink: exit 4, nothing changed", J(r));
  rmSync(P.ETC_DIR); renameSync(P.ETC_DIR + ".real", P.ETC_DIR);
}

section("disable clears the /dev/vhost-vsock ACL unless another rule still grants uaccess; /dev/kvm never");
{
  // Char devices cannot be made unprivileged: the fake nodes are links to /dev/null ([ -c ] follows them).
  const VS = join(P.DEV_DIR, "vhost-vsock");
  symlinkSync("/dev/null", VS); symlinkSync("/dev/null", join(P.DEV_DIR, "kvm"));
  const INFO = "udevadm info --query=property --name=" + VS + "\n";
  const SETF = "setfacl -b -- " + VS + "\n";
  clean(); run(["enable"]);
  let r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: disabled (acl cleared: " + VS + ")\n" && r.log === RELOAD + INFO + SETF,
    "CURRENT_TAGS without uaccess: removed, reload + trigger, then setfacl -b on vhost-vsock only", J(r));
  ok(!/setfacl[^\n]*\/kvm\b|name=[^\n]*\/kvm\n/.test(r.log), "/dev/kvm neither queried nor touched", J(r.log));
  run(["enable"]);
  r = run(["disable"], { FAKE_CURRENT_TAGS: ":seat:uaccess:systemd:" });
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: disabled (acl kept, another udev rule grants it: " + VS + ")\n" && r.log === RELOAD + INFO,
    "another rule still tags uaccess: ACL kept, no setfacl", J(r));
  r = run(["disable"], { FAKE_CURRENT_TAGS: "none" });
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: already disabled (acl kept, udev reports no CURRENT_TAGS: " + VS + ")\n" && r.log === RELOAD + INFO,
    "udev without CURRENT_TAGS: ACL kept, said so", J(r));
  r = run(["disable"]);
  ok(r.status === 0 && r.stdout === "cdb-kvm-access: already disabled (acl cleared: " + VS + ")\n" && r.log === RELOAD + INFO + SETF,
    "already disabled still clears an ACL left behind earlier", J(r));
  run(["enable"]);
  r = run(["disable"], { FAKE_SETFACL_RC: "1" });
  ok(r.status === 4 && r.stdout === "" && /^cdb-kvm-access: disabled, but setfacl -b .*vhost-vsock failed \(the ACL stays until reboot\)$/m.test(r.stderr),
    "setfacl fails: exit 4, says so", J(r));
  // No setfacl on the system: refused before the links change.
  run(["enable"]);
  // A helper copy whose tool dirs are the stubs plus links to the real tools it needs, setfacl not among them.
  rmSync(join(STUBS, "setfacl"));
  const SYS = join(base, "sys");
  mkdirSync(SYS, { recursive: true });
  for (const t of ["readlink", "ln", "rm", "mkdir", "mv", "cat"]) {
    const real = ["/usr/bin", "/bin"].map((d) => d + "/" + t).find((f) => existsSync(f));
    if (real && !existsSync(join(SYS, t))) symlinkSync(real, join(SYS, t));
  }
  writeFileSync(FHELPER, fake.replace(/^TOOL_DIRS='[^']*'$/m, "TOOL_DIRS='" + STUBS + "\n" + SYS + "'"));
  r = run(["disable"]);
  ok(r.status === 4 && r.stdout === "" && /missing tool: setfacl \(install the acl package\); nothing changed/.test(r.stderr) &&
    target(LINK) === SRC && target(MLINK) === MSRC && r.log === "", "no setfacl: exit 4 before any change", J(r));
  writeFileSync(FHELPER, fake);
  stub("setfacl", 'printf \'setfacl %s\\n\' "$*" >> "$FAKE_LOG"\nexit "${FAKE_SETFACL_RC-0}"\n');
  // enable never runs the ACL step.
  r = run(["enable"]);
  ok(r.status === 0 && !/setfacl|udevadm info/.test(r.log), "enable: no ACL step", J(r.log));
  clean(); rmSync(VS); rmSync(join(P.DEV_DIR, "kvm"));
}

section("refusals before any change");
{
  const unchanged = (r) => target(LINK) === null && target(MLINK) === null && r.stdout === "" && r.log === "";
  // Own files: content, type, safety.
  writeFileSync(SRC, ruleFile + " ");
  let r = run(["enable"]);
  ok(r.status === 5 && /does not match the rule this helper ships/.test(r.stderr) && unchanged(r), "rule not byte-identical: exit 5", J(r));
  writeFileSync(SRC, ruleFile.replace('TAG+="uaccess"\n', 'TAG+="uaccess"\0\n'));
  r = run(["enable"]);
  ok(r.status === 5 && unchanged(r), "rule with a NUL byte: exit 5", J(r));
  putFiles();
  writeFileSync(MSRC, confFile + "kvm_intel\n");
  r = run(["enable"]);
  ok(r.status === 5 && /does not match the modules-load file this helper ships/.test(r.stderr) && unchanged(r), "conf not byte-identical: exit 5", J(r));
  putFiles();
  rmSync(MSRC); symlinkSync(SRC, MSRC);
  r = run(["enable"]);
  ok(r.status === 5 && /missing or not a regular file/.test(r.stderr) && unchanged(r), "conf is a symlink: exit 5", J(r));
  rmSync(MSRC); putFiles();
  rmSync(SRC);
  r = run(["enable"]);
  ok(r.status === 5 && unchanged(r), "rule missing: exit 5", J(r));
  putFiles();
  for (const p of [SRC, MSRC, P.PKG_DIR, dirname(P.PKG_DIR)]) {
    r = run(["enable"], { FAKE_UNSAFE: p });
    ok(r.status === 5 && /must be owned by root and not group\/world writable/.test(r.stderr) && unchanged(r), "unsafe " + p.slice(base.length) + ": exit 5", J(r));
  }
  // Host checks.
  for (const m of MARKERS) {
    writeFileSync(R + m, "");
    r = run(["enable"]);
    ok(r.status === 3 && /running inside a container/.test(r.stderr) && unchanged(r), "container marker " + m + ": exit 3", J(r));
    rmSync(R + m);
  }
  writeFileSync(P.NIXOS_MARKER, "");
  r = run(["enable"]);
  ok(r.status === 4 && /programs\.claude-desktop-extra\.kvmAccess\.enable = true;/.test(r.stderr) && unchanged(r), "NixOS: exit 4, names the module option", J(r));
  r = run(["disable"]);
  ok(r.status === 4 && unchanged(r), "NixOS disable: exit 4", J(r));
  rmSync(P.NIXOS_MARKER);
  renameSync(P.MODULES_DIR, P.MODULES_DIR + ".real"); symlinkSync(P.MODULES_DIR + ".real", P.MODULES_DIR);
  r = run(["enable"]);
  ok(r.status === 4 && /modules-load\.d is a symlink/.test(r.stderr) && target(LINK) === null && r.log === "", "/etc/modules-load.d a symlink: exit 4", J(r));
  rmSync(P.MODULES_DIR); renameSync(P.MODULES_DIR + ".real", P.MODULES_DIR);
  renameSync(P.RULES_DIR, P.RULES_DIR + ".real"); symlinkSync(P.RULES_DIR + ".real", P.RULES_DIR);
  r = run(["enable"]);
  ok(r.status === 4 && /rules\.d is a symlink/.test(r.stderr) && target(MLINK) === null && r.log === "", "/etc/udev/rules.d a symlink: exit 4", J(r));
  rmSync(P.RULES_DIR); renameSync(P.RULES_DIR + ".real", P.RULES_DIR);
  // Not at an installed path: a copy in a tree under the temp dir (an extracted build tree).
  const tree = join(base, "tree", "resources", "linux-udev");
  mkdirSync(tree, { recursive: true });
  const th = join(tree, "cdb-kvm-access");
  writeFileSync(th, fake); chmodSync(th, 0o755);
  writeFileSync(join(tree, RULE), ruleFile); writeFileSync(join(tree, CONF), confFile);
  for (const verb of ["enable", "disable"]) {
    r = run([verb], {}, th);
    ok(r.status === 5 && /^cdb-kvm-access: refused: .* is not an installed claude-desktop-extra rule/.test(r.stderr) && unchanged(r),
      verb + " from a tree outside the package dir: exit 5", J(r));
  }
  r = run(["enable"], {}, HELPER);
  ok(r.status === 5 && r.stdout === "", "the unmodified helper from the source tree: exit 5", J([r.status, r.stderr]));
  // udev not running (checked last: the socket goes away).
  await new Promise((res) => server.close(res));
  rmSync(P.UDEV_CONTROL, { force: true });
  r = run(["enable"]);
  ok(r.status === 3 && /udev is not running here/.test(r.stderr) && unchanged(r), "no udev control socket: exit 3", J(r));
  writeFileSync(P.UDEV_CONTROL, "");
  r = run(["enable"]);
  ok(r.status === 3 && unchanged(r), "udev control path a regular file: exit 3", J(r));
}

section("known_src: package path or Nix store shape, per file name");
{
  const fn = (htext.match(/^known_src\(\) \{[\s\S]*?^\}$/m) || [""])[0];
  ok(fn.length > 100, "known_src() found in the helper");
  // The TPM case list, renamed to each of our two files: same shapes, same verdicts.
  const rows = readFileSync(TPM_RULE_PATHS, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));
  ok(rows.length >= 20, "shared case list parsed (" + rows.length + " rows)");
  const known = (paths, name) => spawnSync("/bin/sh", ["-c", "set -eu\nLC_ALL=C\nRULE=" + RULE + "\nCONF=" + CONF +
    "\nPKG_DIR=" + ORIG.PKG_DIR + "\n" + fn + '\nn=$1; shift\nfor p in "$@"; do if known_src "$p" "$n"; then echo yes; else echo no; fi; done',
    "sh", name, ...paths], { encoding: "utf8" }).stdout.split("\n").slice(0, paths.length);
  for (const file of [RULE, CONF]) {
    const paths = rows.map((r) => r[1].split("70-claude-desktop-extra-tpm.rules").join(file));
    const out = known(paths, file);
    const bad = rows.filter((r, i) => out[i] !== r[0]).map((r) => r[2]);
    ok(bad.length === 0, file + ": every case matches the TPM verdicts", J(bad));
  }
  const cross = known([ORIG.PKG_DIR + "/" + CONF, nix("x", CONF), ORIG.PKG_DIR + "/70-claude-desktop-extra-tpm.rules", ORIG.PKG_DIR + "/" + RULE], RULE);
  ok(J(cross) === J(["no", "no", "no", "yes"]), "as the rule: the conf path and the TPM rule path are not ours", J(cross));
  const other = known([ORIG.PKG_DIR + "/other.rules", ORIG.PKG_DIR + "/" + RULE], "other.rules");
  ok(J(other) === J(["no", "no"]), "a file name other than our two: never known", J(other));
  ok(!readFileSync(TPM_RULE_PATHS, "utf8").includes(base), "the shared case list names no harness path");
}

section("single sources: shipped files equal the helper's texts; policy; markers");
{
  const hRule = (htext.match(/^RULE_TEXT='([^']*)'$/m) || [])[1];
  const hConf = (htext.match(/^CONF_TEXT='([^']*)'$/m) || [])[1];
  ok(hRule === ruleFile, "RULE_TEXT is " + RULE + ", byte for byte", J([hRule, ruleFile]));
  ok(hConf === confFile, "CONF_TEXT is " + CONF + ", byte for byte", J([hConf, confFile]));
  const rules = ruleFile.split("\n").filter((l) => l && !l.startsWith("#"));
  ok(J(rules) === J([
    'SUBSYSTEM=="misc", KERNEL=="kvm", ACTION!="remove", TAG+="uaccess"',
    'SUBSYSTEM=="misc", KERNEL=="vhost-vsock", ACTION!="remove", TAG+="uaccess"',
  ]) && !/RUN|PROGRAM|IMPORT|MODE|GROUP|OWNER/.test(ruleFile), "the rule tags only kvm and vhost-vsock with uaccess and runs nothing", J(rules));
  ok(J(confFile.split("\n").filter((l) => l && !l.startsWith("#"))) === J(["vhost_vsock"]), "the modules-load file names vhost_vsock only");
  const pol = readFileSync(join(UDEV, POLICY), "utf8");
  ok((pol.match(/<action id="/g) || []).length === 1 && pol.includes('<action id="io.github.patrickjaja.claude-desktop-extra.kvm-access">'), "policy: one action, the C1 id");
  ok(pol.includes('<annotate key="org.freedesktop.policykit.exec.path">/usr/lib/claude-desktop/resources/linux-udev/cdb-kvm-access</annotate>'),
    "policy: exec.path is the installed helper");
  ok(/<allow_any>no<\/allow_any>\s*<allow_inactive>no<\/allow_inactive>\s*<allow_active>auth_admin<\/allow_active>/.test(pol), "policy: no / no / auth_admin");
  ok(pol.includes("<message>Authentication is required to change whether Claude Desktop can use this computer's virtualization devices (/dev/kvm, /dev/vhost-vsock) for local Cowork</message>"),
    "policy: the C1 message");
  const tmarks = (readFileSync(TPM_HELPER, "utf8").match(/^CONTAINER_MARKERS='([^']*)'$/m) || [])[1];
  const kmarks = (htext.match(/^CONTAINER_MARKERS='([^']*)'$/m) || [])[1];
  ok(kmarks === tmarks && J(kmarks.split("\n")) === J(MARKERS), "container markers: the TPM helper's list, same order", J([kmarks, tmarks]));
  ok((statSync(HELPER).mode & 0o111) === 0o111, "the helper is executable in the tree");
  ok(!/[\u2014]/.test(htext + ruleFile + confFile + pol), "no em-dashes");
}

rmSync(base, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
