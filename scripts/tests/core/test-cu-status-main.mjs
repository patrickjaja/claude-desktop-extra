#!/usr/bin/env node
/*
 * test-cu-status-main.mjs - main-process tests for the Computer Use status block
 * (Settings -> Extra -> Computer Use): the
 * cdb-cu-status:* ipcMain handlers in js/extra_settings_main.js, their
 * cuStatus* wrappers in js/extra_settings_bridge.js, and the unprivileged
 * refusals of the root helper they run (packaging/udev/cdb-tpm-access).
 *
 * What can break a user here:
 *   - an "OK" the app did not observe (the whole point of the page);
 *   - pkexec offered where the helper or a directory above it is not
 *     root-owned (a root shell for whoever can write there), where the helper
 *     is not at an installed location (a rule linked from a /tmp tree dangles
 *     once it is deleted, and whoever recreates it writes a root udev rule),
 *     or in an AppImage / NixOS / container, or run with anything the page
 *     chose;
 *   - pkexec taken from the user's PATH instead of a root-owned setuid
 *     binary at a fixed system path;
 *   - an exit code mapped to the wrong message (a cancelled prompt reported
 *     as a failure with a sudo command, a helper refusal reported as done);
 *   - this run's device state read from an earlier run's log lines.
 *
 * Everything runs against real files, sockets and child processes: pkexec, the
 * helper, the bridge and the launcher are /bin/sh fakes in a temp dir. The
 * module copy under test has its fixed paths (/dev/tpmrm0, the /etc link, the
 * NixOS / container markers, the udev control socket, the pkexec candidates)
 * re-pointed into the temp dir, the temp rule dir added to the known rule
 * directories, the temp dir's sticky ancestors (/tmp) to the accepted sticky
 * directories, and the test user to the trusted owners (the fake tree cannot be
 * root-owned). electron is shimmed. The main.log input is the fixture shared
 * with the launcher's --diagnose harness, re-timed to this process's start.
 *
 * Usage: node scripts/tests/core/test-cu-status-main.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, symlinkSync, rmSync, existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import net from "node:net";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN_JS = process.env.CUS_MAIN_JS || join(ROOT, "js", "extra_settings_main.js");
const BRIDGE_JS = process.env.CUS_BRIDGE_JS || join(ROOT, "js", "extra_settings_bridge.js");
const PAGE_JS = join(ROOT, "js", "extra_settings_page.js");
const HELPER = join(ROOT, "packaging", "udev", "cdb-tpm-access");
const FIXTURE = join(ROOT, "scripts", "tests", "fixtures", "main-log-device.txt");
const RULE_PATHS = join(ROOT, "scripts", "tests", "fixtures", "tpm-rule-paths.tsv");
const RULE_FILE = join(ROOT, "packaging", "udev", "70-claude-desktop-extra-tpm.rules");
const LAUNCHER_SH = join(ROOT, "scripts", "claude-desktop-launcher.sh");
const require2 = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  fail++;
  console.error("  FAIL " + label + (extra !== undefined ? "  -> " + extra : ""));
}
function section(t) { console.log("\n" + t); }
const J = (v) => JSON.stringify(v);

const UID = typeof process.getuid === "function" ? process.getuid() : -1;
if (UID === 0) {
  // As root, access(2) grants everything and the "no access" states cannot be built.
  console.log("SKIP: running as root");
  process.exit(3);
}

// --- fixture tree ----------------------------------------------------------------
const base = realpathSync(mkdtempSync(join(tmpdir(), "cdb-cus-")));
const userData = join(base, "Claude");
const logs = join(userData, "logs");
const res = join(base, "resources");
const udevDir = join(res, "linux-udev");
const bin = join(base, "bin");
const binNoPk = join(base, "bin-nopk");
const etc = join(base, "etc", "udev", "rules.d");
const ctl = join(base, "ctl");
for (const d of [logs, udevDir, bin, binNoPk, etc, ctl]) mkdirSync(d, { recursive: true });
const DEV = join(base, "tpmrm0");
const LINK = join(etc, "70-claude-desktop-extra-tpm.rules");
const SRC = join(udevDir, "70-claude-desktop-extra-tpm.rules");
const NIXOS = join(base, "NIXOS");
const CONTAINER = join(base, "containerenv");
const SOCK = join(base, "udev-control");
const HELPER_FAKE = join(udevDir, "cdb-tpm-access");
const MAINLOG = join(logs, "main.log");
const spawnLog = join(base, "spawn.log");
writeFileSync(spawnLog, "");
writeFileSync(SRC, "# claude-desktop-extra: TPM access for the active seat user\n");

function sh(path, body) {
  writeFileSync(path, "#!/bin/sh\n" + body);
  chmodSync(path, 0o755);
}
const mode = (name, v) => writeFileSync(join(ctl, name), v + "\n");
const log = () => readFileSync(spawnLog, "utf8");
const clearLog = () => writeFileSync(spawnLog, "");

sh(join(bin, "pkexec"), `printf 'pkexec %s\\n' "$*" >> '${spawnLog}'
read -r m < '${ctl}/pkexec'
case "$m" in
  cancel) exit 126 ;;
  noagent) printf 'Error executing command as another user: No authentication agent found.\\n' >&2; exit 127 ;;
  slow) /bin/sleep 1 ;;
  hang) exec /bin/sleep 30 ;;
esac
exec "$@"
`);
sh(HELPER_FAKE, `printf 'helper %s\\n' "$*" >> '${spawnLog}'
read -r m < '${ctl}/helper'
case "$m" in
  enabled) printf 'cdb-tpm-access: enabled (%s -> %s)\\n' '${LINK}' '${SRC}' ;;
  already) printf 'cdb-tpm-access: already enabled\\n' ;;
  disabled) printf 'cdb-tpm-access: disabled\\n' ;;
  e3) printf 'cdb-tpm-access: /run/udev/control is not a socket\\n' >&2; exit 3 ;;
  e4) printf 'cdb-tpm-access: left alone: not our link\\n' >&2; exit 4 ;;
  e5) printf 'cdb-tpm-access: rule missing or unsafe\\n' >&2; exit 5 ;;
  e9) exit 9 ;;
esac
`);
mode("pkexec", "run");
mode("helper", "enabled");
// pkexec must be setuid; the kernel ignores the bit on a script, so this stays a user-run fake.
const PKEXEC_FAKE = join(bin, "pkexec");
chmodSync(PKEXEC_FAKE, 0o4755);
// Sticky ancestors of the temp tree (/tmp): the module accepts only /nix/store by default.
const STICKY_ANC = [];
for (let d = dirname(base); ; d = dirname(d)) {
  if (statSync(d).mode & 0o1000) STICKY_ANC.push(d);
  if (dirname(d) === d) break;
}

const BRIDGE_FAKE = join(base, "x11-bridge-fake");
sh(BRIDGE_FAKE, `printf 'bridge %s\\n' "$*" >> '${spawnLog}'
read -r m < '${ctl}/doctor'
[ "$1" = doctor ] || exit 2
case "$m" in
  ok) printf '{"contract":1,"bridge":"x11-bridge","version":"0.4.0","backend":"x11","session_match":true,"backend_reachable":true,"backend_error":null,"session_supported":false,"restore_token_present":false,"restore_token_path":null,"daemon_running":false,"session_socket":null}\\n' ;;
  portal) printf '{"contract":1,"bridge":"kwin-portal-bridge","version":"1.2.0","backend":"kwin-portal","session_match":true,"backend_reachable":true,"backend_error":null,"session_supported":true,"restore_token_present":true,"restore_token_path":"/x","daemon_running":false,"session_socket":"/y"}\\n' ;;
  unreach) printf '{"contract":1,"version":"0.4.0","session_match":true,"backend_reachable":false,"backend_error":"cannot open display :0","session_supported":false}\\n' ;;
  nomatch) printf '{"contract":1,"version":"0.4.0","session_match":false,"backend_reachable":true,"backend_error":null,"session_supported":false}\\n' ;;
  c0) printf '{"version":"0.1.0"}\\n' ;;
  exit2) exit 2 ;;
  garbage) printf 'not json\\n' ;;
  hang) exec /bin/sleep 30 ;;
esac
`);
mode("doctor", "ok");

const LAUNCHER = join(bin, "claude-desktop-fake");
sh(LAUNCHER, `printf 'launcher %s\\n' "$*" >> '${spawnLog}'
read -r m < '${ctl}/launcher'
case "$m" in
  ok) printf 'KWin screen sharing: forgot the remembered choice.\\nGNOME screen sharing: nothing stored.\\n' ;;
  fail) printf 'KWin screen sharing: could not reset\\n'; exit 1 ;;
esac
`);
mode("launcher", "ok");

// The udev control socket: a real Unix socket.
const server = net.createServer();
await new Promise((r) => server.listen(SOCK, r));

const PATH_OK = bin + ":/usr/bin:/bin";
Object.assign(process.env, { PATH: PATH_OK, XDG_CURRENT_DESKTOP: "XFCE" });
delete process.env.CLAUDE_APPIMAGE_PATH;
delete process.env.CLAUDE_LAUNCHER;
process.resourcesPath = res;

// --- load ----------------------------------------------------------------------
function subst(src, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error("expected exactly one " + from + " in the module, found " + n);
  return src.split(from).join(to);
}
const DIAGS = [];
// The confirmation dialog main shows before every pkexec enable: a fake
// electron.dialog whose answer the test sets (DIALOG.answer: 1 = Enable,
// 0 = Cancel, "throw" = showMessageBox rejects). Every call is recorded.
const DIALOG = { answer: 1, calls: [] };
const FAKE_WIN = { fake: "window" };
// cooldownMs: the Enable hold after a declined/failed Enable. 0 by default so
// the exit-mapping cases can run back to back; the rate-limit section sets it.
function load({ platform, trusted = true, known = true, sticky = true, pkexec = [PKEXEC_FAKE], edits = [], cooldownMs = 0, dialog = true } = {}) {
  let src = readFileSync(MAIN_JS, "utf8");
  src = subst(src, "var __cdbEx_CUS_ENABLE_COOLDOWN_MS = 30000;", "var __cdbEx_CUS_ENABLE_COOLDOWN_MS = " + cooldownMs + ";");
  src = subst(src, '"/dev/tpmrm0"', J(DEV));
  src = subst(src, '"/etc/udev/rules.d/70-claude-desktop-extra-tpm.rules"', J(LINK));
  src = subst(src, '"/etc/NIXOS"', J(NIXOS));
  src = subst(src, '["/run/systemd/container", "/.dockerenv", "/run/.containerenv", "/.flatpak-info"]', J([CONTAINER]));
  src = subst(src, '"/run/udev/control"', J(SOCK));
  if (trusted) src = subst(src, "var __cdbEx_CUS_TRUSTED_UIDS = [0];", "var __cdbEx_CUS_TRUSTED_UIDS = [0, " + UID + "];");
  if (known) src = subst(src, 'var __cdbEx_TPM_RULE_DIRS = ["/usr/lib/claude-desktop/resources/linux-udev"];',
    "var __cdbEx_TPM_RULE_DIRS = " + J(["/usr/lib/claude-desktop/resources/linux-udev", udevDir]) + ";");
  if (sticky) src = subst(src, 'var __cdbEx_CUS_STICKY_DIRS = ["/nix/store"];', "var __cdbEx_CUS_STICKY_DIRS = " + J(["/nix/store", ...STICKY_ANC]) + ";");
  src = subst(src, 'var __cdbEx_CUS_PKEXEC = ["/usr/bin/pkexec", "/bin/pkexec"];', "var __cdbEx_CUS_PKEXEC = " + J(pkexec) + ";");
  for (const [a, b] of edits) src = subst(src, a, b);
  const dir = mkdtempSync(join(tmpdir(), "cdb-cus-mod-"));
  const mod = join(dir, "extra.cjs");
  writeFileSync(mod, src);
  const handlers = {};
  const fakeElectron = {
    app: { getPath: () => userData, on: () => {}, once: () => {}, relaunch: () => {}, exit: () => {} },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} },
    shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} },
    BrowserWindow: { fromWebContents: (wc) => (wc && wc.isFake ? FAKE_WIN : null) }
  };
  if (dialog) {
    fakeElectron.dialog = {
      showMessageBox: (...a) => {
        DIALOG.calls.push(a);
        if (DIALOG.answer === "throw") return Promise.reject(new Error("no display"));
        return Promise.resolve({ response: DIALOG.answer, checkboxChecked: false });
      }
    };
  }
  const Module = require2("module");
  const orig = Module._load;
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Module._load = function (req, ...rest) { return req === "electron" ? fakeElectron : orig.call(this, req, ...rest); };
  // The module logs through whatever __cdbDiag is at call time: one shared sink.
  globalThis.__cdbDiag = (m) => DIAGS.push(String(m));
  try { require2(mod); } finally {
    Module._load = orig;
    if (platform) Object.defineProperty(process, "platform", origPlatform);
  }
  const ev = { sender: { isFake: true, isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
  const call = async (ch, ...args) => {
    if (!handlers[ch]) return { ok: false, error: "no handler for " + ch, missing: true };
    return await handlers[ch](ev, ...args);
  };
  const callAs = async (sender, ch) => handlers[ch](sender);
  return { call, callAs, handlers };
}

// --- main.log from the shared fixture, re-timed to this process --------------------
const TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const parseTs = (l) => { const m = TS.exec(l); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
const p2 = (n) => String(n).padStart(2, "0");
const fmtTs = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()); };
const FIX = readFileSync(FIXTURE, "utf8");
const procStart = Date.now() - process.uptime() * 1000;
// The fixture's current run (its last "Starting app {") starts when this process did.
function retimed(text, runStartMs = procStart) {
  const lines = text.split("\n");
  const starts = lines.filter((l) => / \[info\] Starting app \{$/.test(l)).map(parseTs);
  const delta = runStartMs - starts[starts.length - 1];
  return lines.map((l) => { const t = parseTs(l); return t === null ? l : fmtTs(t + delta) + l.slice(19); }).join("\n");
}
const putLog = (text) => writeFileSync(MAINLOG, text);
const FRAME_RE = "connect frame sent: device_id (keyed|keyless|none)(?: \\((.*)\\))?";

// --- state helpers ---------------------------------------------------------------
function setDev(state) {
  rmSync(DEV, { force: true });
  if (state === "absent") return;
  writeFileSync(DEV, "");
  chmodSync(DEV, state === "ok" ? 0o600 : 0o040);
}
const NIX_GONE = "/nix/store/0000000000000000000000000000000z-cdb-gone/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules";
function setLink(state) {
  rmSync(LINK, { force: true });
  if (state === "ours") symlinkSync(SRC, LINK);
  else if (state === "pkg") symlinkSync("/usr/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules", LINK);
  else if (state === "stale") symlinkSync(NIX_GONE, LINK);
  else if (state === "nixbad") symlinkSync("/nix/store/cdb-gone/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules", LINK);
  else if (state === "tmp") symlinkSync("/tmp/cdb-tree/resources/linux-udev/70-claude-desktop-extra-tpm.rules", LINK);
  else if (state === "foreign") symlinkSync("/dev/null", LINK);
  else if (state === "file") writeFileSync(LINK, "SUBSYSTEM==\"tpmrm\"\n");
}
function setDecision(d) {
  if (d === undefined) { delete globalThis.__cdbCuDecision; return; }
  globalThis.__cdbCuDecision = Object.freeze(Object.assign({ v: 1, mode: "regular", wayland: false, backend: "x11-bridge",
    bin: BRIDGE_FAKE, override: null, target: null, announceWayland: false }, d));
}
function reset() {
  setDev("denied"); setLink("absent"); setDecision({});
  delete globalThis.__cdbTpmAtStart; delete globalThis.__cuBridgeFail;
  rmSync(NIXOS, { force: true }); rmSync(CONTAINER, { force: true });
  delete process.env.CLAUDE_APPIMAGE_PATH; delete process.env.CLAUDE_LAUNCHER;
  process.env.PATH = PATH_OK;
  chmodSync(udevDir, 0o755);
  mode("pkexec", "run"); mode("helper", "enabled"); mode("doctor", "ok"); mode("launcher", "ok");
  putLog(retimed(FIX));
  clearLog();
  DIALOG.answer = 1; DIALOG.calls.length = 0;
}

// The pkexec action exactly as the page shows it: the command is word for word
// what pkexec runs (the resolved pkexec and helper), and Enable names what it
// changes and how to undo it.
const RULE_LINE = readFileSync(RULE_FILE, "utf8").split("\n").filter((l) => l && l[0] !== "#").join("\n");
const APPLY = "udevadm control --reload\nudevadm trigger --action=change --subsystem-match=tpmrm";
function pkAct(verb) {
  const a = { kind: "pkexec", command: PKEXEC_FAKE + " " + HELPER_FAKE + " " + verb, link: LINK, apply: APPLY };
  if (verb === "enable") {
    Object.assign(a, { target: SRC, rule: RULE_LINE, undo: PKEXEC_FAKE + " " + HELPER_FAKE + " disable",
      undoManual: "sudo rm -f " + LINK + " && sudo udevadm control --reload" });
  }
  return J(a);
}

const m = load();
reset();
const read = async () => m.call("cdb-cu-status:read");
const STATUSES = ["ok", "action", "na", "unknown"];

section("registration and source");
{
  const CH = ["read", "tpm-enable", "tpm-disable", "reset-screen-sharing"].map((c) => "cdb-cu-status:" + c);
  ok(CH.every((c) => typeof m.handlers[c] === "function"), "all four cdb-cu-status channels are registered", CH.filter((c) => !m.handlers[c]).join(","));
  ok(log() === "", "loading the module spawns nothing");
  const src = readFileSync(MAIN_JS, "utf8");
  const a = src.indexOf("// --- Computer Use status (Settings -> Extra -> Computer Use)");
  const b = src.indexOf("// --- handlers ---", a);
  const part = a >= 0 && b > a ? src.slice(a, b) : "";
  ok(part.length > 5000 && !/Sync\(/.test(part), "no sync call in the status helpers", (part.match(/\w*Sync\(/g) || []).join(","));
  ok(!/\bset(Timeout|Interval)\(/.test(part) && !/console\.log/.test(part), "no timers and no console.log in the status helpers");
  ok(src.indexOf(FRAME_RE) >= 0, "the main.log device regex is the one shared with --diagnose: " + FRAME_RE);
  const helperDecl = /function __cdbEx_cusHelper\(\) \{\s*return process\.resourcesPath \? _path\.join\(process\.resourcesPath, "linux-udev", "cdb-tpm-access"\) : "";/;
  ok(helperDecl.test(part), "the helper path comes from process.resourcesPath only");
  ok(!/process\.env\.[A-Z_]*(HELPER|TPM)/.test(part), "no environment variable can name the helper or the device");
  const page = readFileSync(PAGE_JS, "utf8");
  const pa = page.indexOf("// --- Computer Use (its own Extra entry)");
  const pb = page.indexOf("// A copyable command block", pa);
  const ppart = pa >= 0 && pb > pa ? page.slice(pa, pb) : "";
  ok(ppart.length > 3000 && !/\bsetInterval\(/.test(ppart) && (ppart.match(/\bsetTimeout\(/g) || []).length === 1 && /,\s*2000\)/.test(ppart),
    "the page's status code has no interval and exactly one timer: the 2 s 'can take up to 8 seconds' note");
  ok(!/\bconfirm\(/.test(ppart) && /api\.cuStatusTpmEnable/.test(ppart), "the page asks no confirm() of its own: main's dialog is the only consent");
}

section("bridge wrappers: fixed channels, no arguments");
{
  const calls = [];
  let exposed = null;
  const sandbox = {
    require: () => ({
      contextBridge: { exposeInMainWorld: (n, api) => { exposed = api; } },
      ipcRenderer: { invoke: (...x) => { calls.push(x); return Promise.resolve({ ok: true }); } }
    }),
    console
  };
  vm.runInNewContext(readFileSync(BRIDGE_JS, "utf8"), vm.createContext(sandbox));
  const api = exposed || {};
  const map = { cuStatusRead: "read", cuStatusTpmEnable: "tpm-enable",
    cuStatusTpmDisable: "tpm-disable", cuStatusResetScreenSharing: "reset-screen-sharing" };
  for (const [n, ch] of Object.entries(map)) {
    calls.length = 0;
    if (typeof api[n] !== "function") { ok(false, n + " exists"); continue; }
    api[n]("/bin/sh", "-c", "id");
    ok(calls.length === 1 && calls[0].length === 1 && calls[0][0] === "cdb-cu-status:" + ch,
      n + " invokes cdb-cu-status:" + ch + " and drops every argument", J(calls));
  }
}

section("sender guard");
{
  const r = await m.callAs({ sender: { isDestroyed: () => false, getURL: () => "https://evil.example/" }, senderFrame: { parent: null } }, "cdb-cu-status:tpm-enable");
  ok(r && r.ok === false && /unrecognized sender/.test(r.error) && log() === "", "a foreign origin is refused and nothing runs", J(r));
}

section("TPM row");
{
  reset(); setDev("absent");
  let r = await read();
  ok(r.ok && r.rows.tpm.status === "na" && r.rows.tpm.fact === "no TPM 2.0 resource manager" && r.actions.tpmEnable === null,
    "no device node: Not available, nothing offered", J(r.rows && r.rows.tpm));
  ok(STATUSES.indexOf(r.rows.desktop.status) >= 0 && typeof r.rows.cloud.note === "string" && r.rows.tpm.note.length > 20,
    "rows carry status, fact and note");

  reset(); setDev("ok");
  r = await read();
  ok(r.rows.tpm.status === "ok" && /accessible$/.test(r.rows.tpm.fact) && r.actions.restart === false, "accessible, start unknown: OK, no restart", J(r.rows.tpm));
  globalThis.__cdbTpmAtStart = Object.freeze({ state: "ok", code: null });
  r = await read();
  ok(r.rows.tpm.status === "ok" && r.actions.restart === false, "accessible now and at start: OK");
  globalThis.__cdbTpmAtStart = Object.freeze({ state: "denied", code: "EACCES" });
  r = await read();
  ok(r.rows.tpm.status === "action" && r.rows.tpm.fact === "accessible now - restart Claude to use it" && r.actions.restart === true,
    "accessible now but not at start: Needs action + Restart now", J(r.rows.tpm));

  reset();
  r = await read();
  ok(r.rows.tpm.status === "action" && /^present, no access for this user \(.+:.+ 40\)$/.test(r.rows.tpm.fact),
    "no access, no rule: owner:group mode in the fact line", r.rows.tpm.fact);
  ok(J(r.actions.tpmEnable) === pkAct("enable") && r.actions.tpmDisable === null && r.actions.tssCommand === null,
    "every gate holds: Enable by pkexec, with its exact command, link, rule, udev reload and undo; no Disable", J(r.actions));
  ok(/^SUBSYSTEM=="tpmrm", .*TAG\+="uaccess"$/.test(RULE_LINE) && r.actions.tpmEnable.rule === RULE_LINE,
    "the rule shown is the shipped rule's one active line", J(r.actions.tpmEnable && r.actions.tpmEnable.rule));

  setLink("ours");
  r = await read();
  ok(r.rows.tpm.fact === "rule enabled, but this session got no access" && r.actions.tpmEnable === null &&
    /^sudo usermod -aG \S+ "\$USER"$/.test(r.actions.tssCommand || "") && J(r.actions.tpmDisable) === pkAct("disable"),
    "our link, still no access: the tss command, and Disable", J(r.actions));
  // Only where the package is not installed: on a host that has it, that
  // path exists and the link is not stale (the "ours" case above covers it).
  if (existsSync("/usr/lib/claude-desktop/resources/linux-udev/70-claude-desktop-extra-tpm.rules")) {
    console.log("  SKIP a link to the package path that is gone: this host has the package installed");
  } else {
    setLink("pkg");
    r = await read();
    ok(r.rows.tpm.fact === "rule link points at a removed install" && J(r.actions.tpmEnable) === pkAct("enable") &&
      J(r.actions.tpmDisable) === pkAct("disable"), "a link to the package path that is gone: stale, Enable re-points it", J(r));
  }
  setLink("stale");
  r = await read();
  ok(r.rows.tpm.fact === "rule link points at a removed install" && !!r.actions.tpmEnable, "a dangling Nix store link: stale");
  for (const st of ["nixbad", "tmp"]) {
    setLink(st);
    r = await read();
    ok(/another file is installed at /.test(r.rows.tpm.fact) && r.actions.tpmEnable === null && r.actions.tpmDisable === null,
      "a link to " + (st === "tmp" ? "a /tmp tree" : "a /nix/store path without the hash-name shape") + ": foreign, never Enable or Disable", J(r));
  }
  setLink("foreign");
  r = await read();
  ok(/^present, no access for this user .* - another file is installed at /.test(r.rows.tpm.fact) &&
    r.actions.tpmEnable === null && r.actions.tpmDisable === null && !!r.actions.tssCommand,
    "a foreign symlink: never Enable or Disable by button, the tss command instead", J(r.actions));
  setLink("file");
  r = await read();
  ok(r.rows.tpm.fact === "rule enabled, but this session got no access" && r.actions.tpmDisable === null && r.actions.tpmEnable === null,
    "a regular file at the link path (outside an AppImage): no Disable", J(r.actions));
  process.env.CLAUDE_APPIMAGE_PATH = "/home/u/Claude.AppImage";
  r = await read();
  ok(r.actions.tpmDisable && r.actions.tpmDisable.kind === "command" && /^sudo rm -f /.test(r.actions.tpmDisable.text) &&
    r.actions.tpmDisable.text.indexOf(LINK) >= 0, "AppImage with its own copied file: Disable is the sudo rm command", J(r.actions.tpmDisable));
}

section("Enable gating: where pkexec is not offered");
{
  const enableOf = async () => (await read()).actions.tpmEnable;
  reset(); process.env.CLAUDE_APPIMAGE_PATH = "/home/u/Claude.AppImage";
  let a = await enableOf();
  ok(a && a.kind === "command" && a.where === "here" && a.text.indexOf("sudo tee " + LINK) >= 0 &&
    a.text.indexOf('TAG+="uaccess"') >= 0 && /udevadm control --reload/.test(a.text) && /subsystem-match=tpmrm/.test(a.text),
    "AppImage: the tee command with the rule text, reload and trigger", J(a));
  reset(); setLink("stale"); process.env.CLAUDE_APPIMAGE_PATH = "/x.AppImage";
  a = await enableOf();
  ok(a && /^sudo rm -f /.test(a.text), "AppImage over a dangling link: removes the link before tee (tee would follow it)", J(a));
  reset(); writeFileSync(NIXOS, "");
  a = await enableOf();
  ok(J(a) === J({ kind: "nixos", text: "programs.claude-desktop-extra.tpmAccess.enable = true;" }), "NixOS: the module option", J(a));
  reset(); writeFileSync(CONTAINER, "");
  a = await enableOf();
  ok(a && a.kind === "command" && a.where === "host" && /sudo tee/.test(a.text), "container: the tee command, run on the host", J(a));
  reset(); server.close(); await new Promise((r) => setTimeout(r, 20));
  a = await enableOf();
  ok(a && a.kind === "command" && a.where === "host", "no udev control socket: run on the host", J(a));
  await new Promise((r) => server.listen(SOCK, r));
  const enableWith = async (opts) => (await load(opts).call("cdb-cu-status:read")).actions.tpmEnable;
  const sudoCmd = (x) => !!x && x.kind === "command" && x.text === "sudo " + HELPER_FAKE + " enable" && x.where === "here";
  reset();
  a = await enableWith({ pkexec: [join(base, "no-pkexec"), join(binNoPk, "pkexec")] });
  ok(sudoCmd(a), "no pkexec at the fixed paths, a pkexec on PATH: PATH is never searched, sudo <helper> enable", J(a));
  reset(); process.env.PATH = binNoPk + ":/nonexistent";
  a = await enableOf();
  ok(J(a) === pkAct("enable"), "and the fixed path is used whatever PATH says", J(a));
  reset();
  const pkPlain = join(binNoPk, "pkexec-plain");
  writeFileSync(pkPlain, readFileSync(PKEXEC_FAKE)); chmodSync(pkPlain, 0o755);
  a = await enableWith({ pkexec: [pkPlain] });
  ok(sudoCmd(a), "a pkexec without the setuid bit: unavailable", J(a));
  a = await enableWith({ pkexec: ["/bin/sh"] });
  ok(sudoCmd(a), "a root-owned binary without the setuid bit: unavailable", J(a));
  a = await enableWith({ edits: [['__cdbEx_CUS_TRUSTED_UIDS.indexOf(st.uid) < 0) return "";', '[0].indexOf(st.uid) < 0) return "";']] });
  ok(sudoCmd(a), "a setuid pkexec not owned by root: unavailable", J(a));
  const pkLink = join(binNoPk, "pkexec-link");
  symlinkSync(PKEXEC_FAKE, pkLink);
  const viaLink = load({ pkexec: [join(base, "no-pkexec"), pkLink] });
  a = (await viaLink.call("cdb-cu-status:read")).actions.tpmEnable;
  ok(J(a) === pkAct("enable"), "first candidate missing, the second a link to a setuid root pkexec: the button, showing the resolved pkexec", J(a));
  clearLog();
  const lr = await viaLink.call("cdb-cu-status:tpm-enable");
  ok(lr.ok === true && log().split("\n").filter((l) => /^pkexec /.test(l)).join("|") === "pkexec " + HELPER_FAKE + " enable",
    "and Enable runs it", J([lr, log()]));
  reset();
  a = await enableWith({ known: false });
  ok(a && a.kind === "command" && /sudo tee/.test(a.text) && a.text.indexOf(HELPER_FAKE) < 0,
    "a helper outside the installed locations (a /tmp tree): never pkexec, never sudo of it - the tee command", J(a));
  if (STICKY_ANC.length) {
    a = await enableWith({ sticky: false });
    ok(a && a.kind === "command" && a.text.indexOf(HELPER_FAKE) < 0,
      "a sticky world-writable ancestor other than /nix/store (" + STICKY_ANC.join(",") + "): never pkexec, never sudo of it", J(a));
  } else {
    console.log("  SKIP the temp tree has no sticky ancestor");
  }
  reset(); chmodSync(udevDir, 0o775);
  a = await enableOf();
  ok(a && a.kind === "command" && /sudo tee/.test(a.text) && a.text.indexOf(HELPER_FAKE) < 0,
    "a group-writable helper directory: never pkexec, never sudo of that helper - the tee command", J(a));
  chmodSync(udevDir, 0o755);
  reset();
  const untrusted = load({ trusted: false });
  const r = await untrusted.call("cdb-cu-status:read");
  ok(r.actions.tpmEnable && r.actions.tpmEnable.kind === "command" && r.actions.tpmEnable.text.indexOf(HELPER_FAKE) < 0,
    "a helper not owned by root: no pkexec, no sudo of it", J(r.actions.tpmEnable));
  const e = await untrusted.call("cdb-cu-status:tpm-enable");
  ok(e.ok === false && e.code === "not-allowed" && !/pkexec/.test(log()), "and the enable channel refuses without running anything", J(e));
}

section("Enable / Disable: pkexec and exit mapping");
{
  reset();
  let r = await m.call("cdb-cu-status:tpm-enable", "/bin/sh", ["-c", "id"]);
  ok(J(r) === J({ ok: true, changed: true, message: "cdb-tpm-access: enabled (" + LINK + " -> " + SRC + ")" }), "enable: ok, changed, the helper's line", J(r));
  ok(log().split("\n").filter(Boolean).join("|") === "pkexec " + HELPER_FAKE + " enable|helper enable",
    "pkexec ran the resolved helper with exactly [enable] - the page's arguments are dropped", log());
  ok(JSON.parse(pkAct("enable")).command === PKEXEC_FAKE + " " + log().split("\n")[0].replace(/^pkexec /, ""),
    "the command the page shows is the one that ran (the pkexec binary plus its argv)", log());
  ok(DIAGS.some((d) => /cu-status: tpm enable -> cdb-tpm-access: enabled/.test(d)), "logged through __cdbDiag");
  reset(); mode("helper", "already");
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.ok === true && r.changed === false && r.message === "cdb-tpm-access: already enabled", "already enabled: ok, not changed", J(r));
  const fails = [["cancel", "run", "cancelled", null], ["noagent", "run", "no-agent", "sudo " + HELPER_FAKE + " enable"],
    ["run", "e3", "helper-3", "sudo " + HELPER_FAKE + " enable"], ["run", "e4", "helper-4", "sudo " + HELPER_FAKE + " enable"],
    ["run", "e5", "helper-5", "sudo " + HELPER_FAKE + " enable"], ["run", "e9", "error", "sudo " + HELPER_FAKE + " enable"]];
  for (const [pk, hp, code, cmd] of fails) {
    reset(); mode("pkexec", pk); mode("helper", hp);
    r = await m.call("cdb-cu-status:tpm-enable");
    ok(r.ok === false && r.code === code && r.command === cmd && typeof r.error === "string" && r.error.length > 0,
      "pkexec " + pk + " / helper " + hp + " -> " + code + (cmd ? " + the sudo command" : ", no command"), J(r));
  }
  reset(); mode("helper", "e4");
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.error === "cdb-tpm-access: left alone: not our link", "a helper refusal carries its stderr line", r.error);
  reset(); mode("pkexec", "cancel");
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.error === "authentication was cancelled", "cancelled says so", r.error);

  reset(); mode("pkexec", "hang");
  const quick = load({ edits: [["var __cdbEx_CUS_PKEXEC_MS = 120000;", "var __cdbEx_CUS_PKEXEC_MS = 300;"]] });
  r = await quick.call("cdb-cu-status:tpm-enable");
  ok(r.ok === false && r.code === "timeout", "a pkexec that never returns: timeout", J(r));

  reset(); mode("pkexec", "slow");
  const p1 = m.call("cdb-cu-status:tpm-enable");
  const p2r = await m.call("cdb-cu-status:tpm-disable");
  const p1r = await p1;
  ok(p2r.ok === false && p2r.code === "busy" && p1r.ok === true, "single flight: a second change while one runs answers busy", J([p1r, p2r]));

  reset(); setLink("ours"); mode("helper", "disabled");
  r = await m.call("cdb-cu-status:tpm-disable");
  ok(r.ok === true && r.changed === true && /pkexec .* disable/.test(log()), "disable: our link -> pkexec <helper> disable", J(r));
  for (const st of ["absent", "foreign", "file"]) {
    reset(); setLink(st);
    r = await m.call("cdb-cu-status:tpm-disable");
    ok(r.ok === false && r.code === "not-allowed" && log() === "", "disable with " + st + " at the link path: refused, nothing runs", J(r));
  }
  reset(); process.env.CLAUDE_APPIMAGE_PATH = "/x.AppImage";
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.ok === false && r.code === "not-allowed" && /sudo tee/.test(r.command || "") && log() === "",
    "enable inside an AppImage: refused with the command, pkexec never runs", J(r));
  reset(); setDev("ok");
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.ok === false && r.code === "not-allowed" && log() === "", "enable when the TPM is already accessible: refused", J(r));
}

section("Enable consent: main's confirmation dialog, then pkexec");
{
  const pkLines = () => log().split("\n").filter((l) => /^pkexec /.test(l));
  const mainConfirm = JSON.parse((readFileSync(MAIN_JS, "utf8").match(/^ {2}var __cdbEx_CUS_TPM_CONFIRM = (".*");$/m) || ["", "null"])[1]);
  ok(typeof mainConfirm === "string" && /udev rule/.test(mainConfirm) && /administrator password/.test(mainConfirm) &&
    /every account that logs in at this computer's screen/.test(mainConfirm) &&
    /Details and the exact command: Settings -> Extra -> Computer Use\.$/.test(mainConfirm) &&
    (mainConfirm.match(/[.!?](\s|$)/g) || []).length <= 3 && !/\u2014/.test(mainConfirm),
    "the dialog text is short (at most 3 sentences): the udev rule, the administrator password, every seat account, where the details are", mainConfirm);
  reset(); DIALOG.answer = 0;
  let r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.ok === false && r.code === "declined" && r.command === null && pkLines().length === 0 && DIALOG.calls.length === 1,
    "Cancel in the dialog: declined, pkexec never runs", J([r, log()]));
  const [win, opts] = DIALOG.calls[0] || [];
  ok(win === FAKE_WIN && opts && opts.type === "warning" && J(opts.buttons) === J(["Cancel", "Enable TPM access"]) &&
    opts.defaultId === 0 && opts.cancelId === 0 && opts.noLink === true && opts.detail === mainConfirm && /TPM/.test(opts.message),
    "the dialog: parented on the sender's window, warning, Cancel default and cancel, the short consent text as detail", J(DIALOG.calls[0]));
  reset(); DIALOG.answer = 1;
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.ok === true && DIALOG.calls.length === 1 && pkLines().join("|") === "pkexec " + HELPER_FAKE + " enable",
    "Enable in the dialog: pkexec <helper> enable runs once", J([r, log()]));
  reset(); DIALOG.answer = "throw";
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.ok === false && r.code === "declined" && pkLines().length === 0, "the dialog failing: declined, pkexec never runs", J(r));
  reset(); DIALOG.answer = 7;
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.code === "declined" && pkLines().length === 0, "any answer but the Enable button (Escape, closed): declined", J(r));
  const noDialog = load({ dialog: false });
  reset();
  r = await noDialog.call("cdb-cu-status:tpm-enable");
  ok(r.code === "declined" && pkLines().length === 0, "no dialog API: declined, never an unconfirmed pkexec", J(r));
  reset();
  const winless = await m.callAs({ sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } }, "cdb-cu-status:tpm-enable");
  ok(winless.ok === true && DIALOG.calls.length === 1 && DIALOG.calls[0].length === 1 && DIALOG.calls[0][0].detail === mainConfirm,
    "a sender with no window: the dialog still shows, unparented", J(DIALOG.calls));
  reset(); setLink("ours"); mode("helper", "disabled");
  r = await m.call("cdb-cu-status:tpm-disable");
  ok(r.ok === true && DIALOG.calls.length === 0 && /pkexec .* disable/.test(log()), "Disable: no dialog, pkexec directly", J(r));
  reset(); setDev("ok");
  r = await m.call("cdb-cu-status:tpm-enable");
  ok(r.code === "not-allowed" && DIALOG.calls.length === 0, "a refused state never shows the dialog", J(r));
  reset(); mode("pkexec", "slow");
  const p1 = m.call("cdb-cu-status:tpm-enable");
  const p2 = await m.call("cdb-cu-status:tpm-enable");
  await p1;
  ok(p2.code === "busy" && DIALOG.calls.length === 1, "a second Enable while one runs: busy, one dialog", J(p2));
}

section("Enable rate limit: 30 s after a declined or failed Enable");
{
  const pkLines = () => log().split("\n").filter((l) => /^pkexec /.test(l));
  const src = readFileSync(MAIN_JS, "utf8");
  ok(/var __cdbEx_CUS_ENABLE_COOLDOWN_MS = 30000;/.test(src), "the shipped cooldown is 30 s");
  const held = load({ cooldownMs: 30000 });
  reset(); DIALOG.answer = 0;
  let r = await held.call("cdb-cu-status:tpm-enable");
  ok(r.code === "declined", "first Enable declined", J(r));
  reset(); DIALOG.answer = 1;
  r = await held.call("cdb-cu-status:tpm-enable");
  ok(r.ok === false && r.code === "cooldown" && /try again in \d+ s/.test(r.error) && r.command === null &&
    DIALOG.calls.length === 0 && pkLines().length === 0, "Enable right after: cooldown, no dialog, no pkexec", J(r));
  reset(); setLink("ours"); mode("helper", "disabled");
  r = await held.call("cdb-cu-status:tpm-disable");
  ok(r.ok === true, "Disable is not held by the Enable cooldown", J(r));
  const held2 = load({ cooldownMs: 30000 });
  reset(); mode("pkexec", "cancel");
  r = await held2.call("cdb-cu-status:tpm-enable");
  reset();
  const r2 = await held2.call("cdb-cu-status:tpm-enable");
  ok(r.code === "cancelled" && r2.code === "cooldown" && DIALOG.calls.length === 0, "a cancelled polkit prompt starts it too", J([r, r2]));
  const held3 = load({ cooldownMs: 30000 });
  reset(); mode("helper", "e5");
  r = await held3.call("cdb-cu-status:tpm-enable");
  reset();
  const r3 = await held3.call("cdb-cu-status:tpm-enable");
  ok(r.code === "helper-5" && r3.code === "cooldown", "so does a helper error", J([r, r3]));
  const held4 = load({ cooldownMs: 30000 });
  reset(); setDev("ok");
  r = await held4.call("cdb-cu-status:tpm-enable");
  reset();
  const r4 = await held4.call("cdb-cu-status:tpm-enable");
  ok(r.code === "not-allowed" && r4.ok === true, "a refused state (no prompt shown) does not", J([r, r4]));
  reset();
  const r5 = await held4.call("cdb-cu-status:tpm-enable");
  ok(r5.ok === true && DIALOG.calls.length === 1, "nor does a successful Enable", J(r5));
  const short = load({ cooldownMs: 300 });
  reset(); DIALOG.answer = 0;
  await short.call("cdb-cu-status:tpm-enable");
  reset();
  r = await short.call("cdb-cu-status:tpm-enable");
  await new Promise((res) => setTimeout(res, 400));
  reset();
  const r6 = await short.call("cdb-cu-status:tpm-enable");
  ok(r.code === "cooldown" && r6.ok === true && pkLines().length === 1, "after the window: Enable asks again and runs", J([r, r6]));
}

section("desktop row: decision and doctor");
{
  const desk = async () => (await read()).rows.desktop;
  reset();
  let d = await desk();
  ok(d.status === "ok" && d.fact === "XFCE X11 - x11-bridge 0.4.0 ready", "doctor contract 1: OK with session, bridge, version", d.fact);
  ok(/bridge doctor/.test(log()), "the read ran doctor");
  setDecision({ override: "X11_BRIDGE_BIN" });
  d = await desk();
  ok(/ready \(override X11_BRIDGE_BIN\)$/.test(d.fact), "an override is named", d.fact);
  reset(); mode("doctor", "portal"); setDecision({ wayland: true, mode: "kwin-wayland", backend: "kwin-portal-bridge", announceWayland: true });
  process.env.CLAUDE_LAUNCHER = LAUNCHER;
  let r = await read();
  ok(r.rows.desktop.status === "ok" && /kwin-portal-bridge 1\.2\.0 ready - screen-sharing permission remembered$/.test(r.rows.desktop.fact) &&
    r.actions.resetScreenSharing === true, "a portal bridge with a grant: remembered, Reset offered", J(r.rows.desktop));
  delete process.env.CLAUDE_LAUNCHER;
  r = await read();
  ok(r.actions.resetScreenSharing === false, "no CLAUDE_LAUNCHER: no Reset");
  reset(); r = await read();
  ok(r.actions.resetScreenSharing === false, "a bridge without sessions: no Reset");
  for (const [md, re, st] of [["unreach", /^backend unreachable: cannot open display :0$/, "action"],
    ["nomatch", /session_match false/, "action"], ["c0", /\(contract 0\)$/, "unknown"], ["exit2", /\(contract 0\)$/, "unknown"],
    ["garbage", /\(not JSON\)$/, "unknown"]]) {
    reset(); mode("doctor", md);
    d = await desk();
    ok(d.status === st && re.test(d.fact), "doctor " + md + " -> " + st, J(d));
  }
  reset(); mode("doctor", "hang");
  const quick = load({ edits: [["var __cdbEx_CUS_DOCTOR_MS = 8000;", "var __cdbEx_CUS_DOCTOR_MS = 300;"]] });
  r = await quick.call("cdb-cu-status:read");
  ok(r.rows.desktop.status === "unknown" && /\(timeout\)$/.test(r.rows.desktop.fact), "a hung doctor: Unknown (timeout), never OK", J(r.rows.desktop));
  reset(); setDecision(undefined);
  d = await desk();
  ok(d.status === "unknown" && !/bridge doctor/.test(log()), "no decision from the preamble: Unknown, no spawn", J(d));
  reset(); setDecision({ backend: "fallback", bin: null });
  d = await desk();
  ok(d.status === "na" && /fallback route/.test(d.fact), "fallback route: Not available", J(d));
  globalThis.__cuBridgeFail = { "wlroots-bridge": { path: "/x", cause: "GLIBC_2.39 not found", hint: "update the system" } };
  d = await desk();
  ok(d.status === "action" && d.fact === "wlroots-bridge cannot run: GLIBC_2.39 not found - update the system", "a bridge that cannot run says why", d.fact);
  reset(); setDecision({ backend: "none", bin: null });
  d = await desk();
  ok(d.status === "na", "no backend: Not available");
  reset(); setDecision({ target: { kind: "x11", display: ":99" } });
  d = await desk();
  ok(d.status === "ok" && /^background display x11 :99/.test(d.fact) && !/bridge doctor/.test(log()), "a background display target: its own line", J(d));
  reset(); setDecision({ target: { invalid: "display :99 is not running" } });
  d = await desk();
  ok(d.status === "action" && /display :99 is not running/.test(d.fact), "an invalid target: Needs action", J(d));
  reset(); setDecision({ bin: "relative/bridge" });
  d = await desk();
  ok(d.status !== "ok" && !/bridge doctor/.test(log()), "a non-absolute bin is never run", J(d));
}

section("cloud row: this run's main.log lines (shared fixture)");
{
  const cloud = async () => (await read()).rows.cloud;
  reset();
  let c = await cloud();
  ok(c.status === "ok" && c.fact === "device keyed, computer tools offered", "the fixture's last line of this run is keyed with computer tools", J(c));
  const fixLines = retimed(FIX).split("\n");
  const lastKeyed = fixLines.map((l, i) => /device_id keyed/.test(l) ? i : -1).filter((i) => i >= 0).pop();
  const noLastKeyed = fixLines.slice(0, lastKeyed).join("\n");
  reset(); putLog(noLastKeyed);
  c = await cloud();
  ok(c.status === "action" && c.fact === "device keyless (row_pk_no_row) - TPM not accessible, see above",
    "keyless in this run beats the earlier run's keyed line", J(c));
  setDev("ok");
  c = await cloud();
  ok(c.status === "action" && /although the TPM is accessible - run claude-desktop --diagnose$/.test(c.fact), "keyless with the TPM accessible: the Q6 warning", J(c));
  setDev("absent");
  c = await cloud();
  ok(c.status === "na" && /no TPM 2\.0/.test(c.fact), "keyless without a TPM: Not available", J(c));
  reset(); putLog(retimed(FIX, procStart + 3600 * 1000 * -2));
  c = await cloud();
  ok(c.status === "unknown" && /^not reported yet in this run/.test(c.fact), "only earlier runs in the log: Unknown, not OK", J(c));
  reset(); rmSync(MAINLOG);
  c = await cloud();
  ok(c.status === "unknown" && c.fact === "main.log not found", "no main.log: Unknown", J(c));
  const now = fmtTs(Date.now());
  const keyedNoCu = now + " [info] [remote-tools-device] connecting DO bridge with: get_device_info, device_bash\n" +
    now + " [info] [remote-tools-device] connect frame sent: device_id keyed\n";
  reset(); putLog(keyedNoCu); setDecision({ wayland: true, backend: "fallback", bin: null, announceWayland: false });
  c = await cloud();
  ok(c.status === "na" && c.fact === "computer tools not offered: no first-party bridge usable on this Wayland session", "keyed, no computer tools, Wayland without a bridge", J(c));
  setDecision({});
  c = await cloud();
  ok(c.status === "na" && /withheld by the app/.test(c.fact), "keyed, no computer tools, otherwise: withheld", J(c));
  reset(); putLog(now + " [info] [remote-tools-device] connect frame sent: device_id keyed\n");
  c = await cloud();
  ok(c.status === "unknown", "keyed but no tool announce in this run: Unknown", J(c));
  reset(); putLog(now + " [info] [remote-tools-device] connect frame sent: device_id none\n");
  c = await cloud();
  ok(c.status === "action" && /^device keyless \(no device id\)/.test(c.fact), "device_id none: keyless", J(c));
  reset(); putLog("x".repeat(100) + "\n" + ("y".repeat(200) + "\n").repeat(4000) + retimed(FIX).split("\n").slice(-40).join("\n"));
  c = await cloud();
  ok(c.status === "ok", "a log over 512 KiB: the tail still holds this run's lines", J(c));
  reset(); putLog(fmtTs(Date.now() + 60000) + " [info] something\n");
  c = await cloud();
  ok(c.status === "unknown" && /rotated/.test(c.fact), "a log that starts after this run began: rotated, Unknown", J(c));
}

section("reset screen sharing");
{
  reset(); process.env.CLAUDE_LAUNCHER = LAUNCHER;
  let r = await m.call("cdb-cu-status:reset-screen-sharing", "--diagnose");
  ok(J(r) === J({ ok: true, lines: ["KWin screen sharing: forgot the remembered choice.", "GNOME screen sharing: nothing stored."] }),
    "runs $CLAUDE_LAUNCHER --reset-screen-sharing and returns its lines verbatim", J(r));
  ok(log().trim() === "launcher --reset-screen-sharing", "with exactly that argument", log());
  mode("launcher", "fail");
  r = await m.call("cdb-cu-status:reset-screen-sharing");
  ok(r.ok === false && /exit 1/.test(r.error) && /could not reset/.test(r.error), "a failing launcher: ok false with its output", J(r));
  delete process.env.CLAUDE_LAUNCHER;
  r = await m.call("cdb-cu-status:reset-screen-sharing");
  ok(r.ok === false && /CLAUDE_LAUNCHER/.test(r.error), "no CLAUDE_LAUNCHER: refused", J(r));
}

section("win32 build (downstream): every channel refuses");
{
  const w = load({ platform: "win32" });
  const outs = await Promise.all(["read", "tpm-enable", "tpm-disable", "reset-screen-sharing"].map((c) => w.call("cdb-cu-status:" + c)));
  ok(outs.every((o) => J(o) === J({ ok: false, error: "Computer Use status is Linux only" })), "Linux only, from every channel", J(outs));
}

section("helper (packaging/udev/cdb-tpm-access), run unprivileged");
if (!existsSync(HELPER)) {
  console.log("  SKIP helper not present yet");
} else {
  const run = (args, helper = HELPER) => spawnSync("/bin/sh", [helper, ...args], { encoding: "utf8" });
  // A root-owned copy under /tmp (an extracted build tree) is the case that matters;
  // this copy is the user's, and the location check refuses before the root check.
  const tmpTree = join(base, "tree", "resources", "linux-udev");
  mkdirSync(tmpTree, { recursive: true });
  const tmpHelper = join(tmpTree, "cdb-tpm-access");
  writeFileSync(tmpHelper, readFileSync(HELPER)); chmodSync(tmpHelper, 0o755);
  writeFileSync(join(tmpTree, "70-claude-desktop-extra-tpm.rules"), readFileSync(join(dirname(HELPER), "70-claude-desktop-extra-tpm.rules")));
  for (const verb of ["enable", "disable"]) {
    const r = run([verb], tmpHelper);
    ok(r.status === 5 && r.stdout === "" && /^cdb-tpm-access: refused: .* is not an installed claude-desktop-extra rule/.test(r.stderr),
      verb + " from a tree under " + dirname(base) + ": exit 5, nothing on stdout, no link", J([r.status, r.stdout, r.stderr]));
  }
  let r = run(["enable"]);
  ok(r.status === 5 && r.stdout === "", "enable from the source tree: exit 5", J([r.status, r.stderr]));
  for (const args of [[], ["bogus"], ["enable", "extra"]]) {
    r = run(args);
    ok(r.status === 2 && r.stdout === "", "usage " + J(args) + ": exit 2", J([r.status, r.stderr]));
  }
  // known_src(), spliced from the helper and run by /bin/sh: the rule paths it may link
  // and the link targets it may remove (dangling or not).
  const htext = readFileSync(HELPER, "utf8");
  const fn = (htext.match(/^known_src\(\) \{[\s\S]*?^\}$/m) || [""])[0];
  ok(fn.length > 100, "known_src() found in the helper");
  const R = "70-claude-desktop-extra-tpm.rules";
  ok(!readFileSync(RULE_PATHS, "utf8").includes(tmpTree), "the shared case list names no harness path");
  const known = (p) => spawnSync("/bin/sh", ["-c", "set -eu\nLC_ALL=C\nRULE=" + R + "\nPKG_SRC=/usr/lib/claude-desktop/resources/linux-udev/$RULE\n" +
    fn + '\nif known_src "$1"; then echo yes; else echo no; fi', "sh", p], { encoding: "utf8" }).stdout.trim();
  ok(known(tmpTree + "/" + R) === "no", "known_src: this harness's temp tree -> no");
}

section("one rule-path predicate: helper, main and launcher on the shared case list");
{
  const R = "70-claude-desktop-extra-tpm.rules";
  const htext = readFileSync(HELPER, "utf8");
  const hfn = (htext.match(/^known_src\(\) \{[\s\S]*?^\}$/m) || [""])[0];
  const msrc = readFileSync(MAIN_JS, "utf8");
  const grab = (re, what) => { const mm = msrc.match(re); if (!mm) throw new Error("not found in the module: " + what); return mm[0]; };
  const jsFn = vm.runInNewContext(
    grab(/^ {2}var __cdbEx_TPM_RULE = .*$/m, "__cdbEx_TPM_RULE") + "\n" +
    grab(/^ {2}var __cdbEx_TPM_RULE_DIRS = .*$/m, "__cdbEx_TPM_RULE_DIRS") + "\n" +
    grab(/^ {2}var __cdbEx_TPM_NIX_DIR_RE = .*$/m, "__cdbEx_TPM_NIX_DIR_RE") + "\n" +
    grab(/^ {2}function __cdbEx_cusKnownRule\(p\) \{[\s\S]*?^ {2}\}$/m, "__cdbEx_cusKnownRule") + "\n__cdbEx_cusKnownRule;",
    vm.createContext({ _path: require2("path") }));
  const lsrc = readFileSync(LAUNCHER_SH, "utf8");
  const lfn = (lsrc.match(/^_cdb_tpm_rule_ours\(\) \{[\s\S]*?^\}$/m) || [""])[0];
  ok(hfn.length > 100 && lfn.length > 100, "known_src() and _cdb_tpm_rule_ours() found");
  const rows = readFileSync(RULE_PATHS, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));
  ok(rows.length >= 20 && rows.every((r) => r.length === 3 && (r[0] === "yes" || r[0] === "no")), "the case list parses (" + rows.length + " cases)");
  // One shell per predicate for the whole list (the paths go in as arguments).
  const shLoop = (shell, prelude, fnText, call) => spawnSync(shell, ["-c", prelude + fnText +
    '\nfor p in "$@"; do if ' + call + ' "$p"; then echo yes; else echo no; fi; done', "x", ...rows.map((r) => r[1])],
    { encoding: "utf8" }).stdout.split("\n").slice(0, rows.length);
  const hOut = shLoop("/bin/sh", "set -eu\nLC_ALL=C\nRULE=" + R + "\nPKG_SRC=/usr/lib/claude-desktop/resources/linux-udev/$RULE\n", hfn, "known_src");
  const lOut = shLoop("bash", "", lfn, "_cdb_tpm_rule_ours");
  rows.forEach(([want, p, what], i) => {
    const j = jsFn(p) ? "yes" : "no";
    ok(hOut[i] === want && j === want && lOut[i] === want, want + ": " + what, "helper " + hOut[i] + ", main " + j + ", launcher " + lOut[i]);
  });
}

section("single sources: rule text, risk text, container markers");
{
  const htext = readFileSync(HELPER, "utf8");
  const msrc = readFileSync(MAIN_JS, "utf8");
  const fileText = readFileSync(RULE_FILE, "utf8");
  const hRule = (htext.match(/^RULE_TEXT='([^']*)'$/m) || [])[1];
  const jsRuleExpr = (msrc.match(/^ {2}var __cdbEx_TPM_RULE_TEXT = ([\s\S]*?);$/m) || [])[1];
  const jsRule = jsRuleExpr ? vm.runInNewContext("(" + jsRuleExpr + ")") : undefined;
  ok(typeof hRule === "string" && hRule === fileText, "the helper's RULE_TEXT is the shipped rule file, byte for byte", J([hRule, fileText]));
  ok(jsRule === fileText, "__cdbEx_TPM_RULE_TEXT is the shipped rule file, byte for byte", J([jsRule, fileText]));
  ok(/^SUBSYSTEM=="tpmrm", KERNEL=="tpmrm\[0-9\]\*", ACTION!="remove", TAG\+="uaccess"$/m.test(fileText) && !/tpm0"|RUN|PROGRAM|IMPORT/.test(fileText),
    "the rule tags only tpmrm nodes with uaccess, and runs nothing");
  // The copy command an AppImage user runs writes exactly that file.
  reset(); process.env.CLAUDE_APPIMAGE_PATH = "/x.AppImage";
  const en = (await read()).actions.tpmEnable;
  const pr = en && en.kind === "command" ? en.text.split("\n").find((l) => l.startsWith("printf ")) : "";
  const printed = pr ? spawnSync("/bin/sh", ["-c", pr.slice(0, pr.indexOf(" | sudo tee "))], { encoding: "utf8" }).stdout : null;
  ok(printed === fileText, "the AppImage tee command writes the shipped rule file, byte for byte", J([pr, printed]));
  reset();
  const page = readFileSync(PAGE_JS, "utf8");
  const pageRisk = (page.match(/^ {2}var CUS_RISK = (".*");$/m) || [])[1];
  ok(!!pageRisk && !/__cdbEx_CUS_TPM_RISK/.test(msrc),
    "the full risk text has one home, the page (the dialog points there instead of repeating it)");
  const risk = pageRisk ? JSON.parse(pageRisk) : "";
  ok(/every account that logs in at this computer's screen/.test(risk) && /\/dev\/tpmrm0, never \/dev\/tpm0/.test(risk) &&
    /clearing it/.test(risk) && /dictionary-attack lockout/.test(risk) && /tpm2_changeauth -c lockout/.test(risk) &&
    /tpm2_changeauth -c owner/.test(risk) && !/tss/.test(risk), "the risk text: every seat account, tpmrm0 only, clear/lockout/owner, changeauth, no tss comparison");
  const hMarks = ((htext.match(/^CONTAINER_MARKERS='([^']*)'$/m) || [])[1] || "").split("\n");
  const jMarks = JSON.parse((msrc.match(/^ {2}var __cdbEx_CUS_CONTAINER = (\[.*\]);$/m) || [])[1] || "null");
  ok(J(hMarks) === J(jMarks) && J(jMarks) === J(["/run/systemd/container", "/.dockerenv", "/run/.containerenv", "/.flatpak-info"]),
    "one container marker list in the helper and main", J([hMarks, jMarks]));
}

{
  const htext = readFileSync(HELPER, "utf8");
  ok(/\[ "\$1" = \/nix\/store \] && \[ \$\(\(_m & 01000\)\) -ne 0 \]/.test(htext) && !/dirs: unless sticky/.test(htext),
    "the helper's sticky exception is /nix/store only");
}

server.close();
rmSync(base, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
