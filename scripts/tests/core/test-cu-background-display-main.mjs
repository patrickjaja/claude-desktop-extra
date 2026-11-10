#!/usr/bin/env node
/*
 * test-cu-background-display-main.mjs - main-process tests for the setup half of
 * "Computer Use on a background display" (issue #300): the cdb-cubg:* ipcMain
 * handlers in js/extra_settings_main.js and their cuBackground* wrappers in
 * js/extra_settings_bridge.js.
 *
 * What can break a user here is not the patch insertion but the BEHAVIOUR:
 *   - the user's own desktop offered (or saved) as "display 2";
 *   - a write that does not produce the exact settings contract the executor
 *     reads, or that overrides a hand-edited .jsonc;
 *   - an env map with PATH / CLAUDE_ELECTRON / LD_* accepted;
 *   - a probe that runs the bridge against the wrong display, leaks the host's
 *     toolkit/compositor variables into it, or blocks the main process.
 *
 * Everything runs against real files and real child processes: the bridges,
 * xprop, xclip and Xvfb are tiny /bin/sh fakes in a temp dir that answer per
 * display and log the environment they were started with. The X11 socket dir
 * is the only thing re-pointed: the module copy under test has its
 * "/tmp/.X11-unix" literal replaced by a temp dir holding real Unix sockets.
 * electron is shimmed.
 *
 * Usage: node scripts/tests/core/test-cu-background-display-main.mjs
 *   CUBG_MAIN_JS / CUBG_BRIDGE_JS override the files under test (old-code runs).
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import net from "node:net";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN_JS = process.env.CUBG_MAIN_JS || join(ROOT, "js", "extra_settings_main.js");
// The core patch emits it ahead of the module above: the shared IPC sender guard.
const GUARD_JS = join(ROOT, "js", "sender_guard.js");
const BRIDGE_JS = process.env.CUBG_BRIDGE_JS || join(ROOT, "js", "extra_settings_bridge.js");
// The executor's reader of the same key, for the cross-reader contract below.
const PREAMBLE_JS = process.env.CU_PREAMBLE || join(ROOT, "js", "cu_mode_preamble.js");
const require2 = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  fail++;
  console.error("  FAIL " + label + (extra !== undefined ? "  -> " + extra : ""));
}
function section(t) { console.log("\n" + t); }
const KEY = "computerUseBackgroundDisplay";

// --- fixture -----------------------------------------------------------------
const base = mkdtempSync(join(tmpdir(), "cdb-cubg-"));
const userData = join(base, "Claude");
const x11Dir = join(base, "x11-unix");
const runtime = join(base, "run");
const bin = join(base, "bin");
const res = join(base, "resources");
const logFile = join(base, "spawn.log");
for (const d of [userData, x11Dir, runtime, bin, res]) mkdirSync(d, { recursive: true });
chmodSync(runtime, 0o700);
writeFileSync(logFile, "");

function sh(path, body) {
  writeFileSync(path, "#!/bin/sh\n" + body);
  chmodSync(path, 0o755);
}
const LOGLINE = (tag) => `printf '%s\\n' "${tag} $* D=\${DISPLAY-unset} W=\${WAYLAND_DISPLAY-unset} T=\${XDG_SESSION_TYPE-unset} ` +
  `G=\${GDK_BACKEND-unset} Q=\${QT_QPA_PLATFORM-unset} S=\${SWAYSOCK-unset} H=\${HOSTVAR-unset} XA=\${XAUTHORITY-unset}" >> '${logFile}'\n`;

// x11-bridge stand-in: :97 healthy, :95 without XTEST, :93 healthy but no WM
// (decided by the xprop fake), :94 hangs, everything else is not running.
const x11Fake = join(base, "x11-bridge-fake");
// :88 and :90 hold until a release file appears, so the queue tests can fill
// the child queue deterministically.
sh(x11Fake, LOGLINE("x11") + `
if [ "$DISPLAY" = ":88" ]; then while [ ! -e '${base}/release-88' ]; do /bin/sleep 0.05; done; exit 1; fi
if [ "$DISPLAY" = ":90" ] && [ "$1" = screens ]; then while [ ! -e '${base}/release-90' ]; do /bin/sleep 0.05; done; fi
case "$DISPLAY" in
  :97|:95|:93|:90) ;;
  :94) exec /bin/sleep 30 ;;
  :92) /bin/sleep 0.3; exit 1 ;;
  *) printf 'failed to connect to the X server (is $DISPLAY set?): Connection refused (os error 111)\\n' >&2; exit 1 ;;
esac
case "$1" in
  screens) printf '[{"id":"screen","name":"screen","geometry":{"x":0,"y":0,"width":1280,"height":800},"scale":1.0,"refresh_millihz":null,"is_active":true,"is_primary":true}]\\n' ;;
  doctor) if [ "$DISPLAY" = ":95" ]; then printf '{"display":":95","extensions":{"xtest":false,"randr":true}}\\n'; else printf '{"display":"%s","extensions":{"xtest":true,"randr":true,"xfixes":true}}\\n' "$DISPLAY"; fi ;;
  windows) printf '[{"id":"0x1"},{"id":"0x2"}]\\n' ;;
  screenshot) printf '{"base64":"QUJD","width":1280,"height":800,"displayWidth":1280,"displayHeight":800,"displayId":"screen","originX":0,"originY":0}\\n' ;;
  pointer-move) printf '{"action":"move","x":%s,"y":%s}\\n' "$3" "$5" ;;
  *) exit 2 ;;
esac
`);
// wlroots-bridge stand-in, found through process.resourcesPath (no env override).
// Matched on the socket's basename: whichever spelling of a socket reaches
// the bridge first (coalescing picks one) must answer the same.
sh(join(res, "wlroots-bridge"), LOGLINE("wlr") + `
case "\${WAYLAND_DISPLAY##*/}" in
  wayland-5|wayland-weston) ;;
  *) printf 'failed to connect to the Wayland compositor (is WAYLAND_DISPLAY set?): Could not find wayland compositor\\n' >&2; exit 1 ;;
esac
case "$1" in
  screens) printf '[{"id":"HEADLESS-1","name":"HEADLESS-1","geometry":{"x":0,"y":0,"width":1920,"height":1080},"scale":1.0,"is_primary":true}]\\n' ;;
  doctor) if [ "\${WAYLAND_DISPLAY##*/}" = "wayland-weston" ]; then printf '{"compositor":"unknown","globals":{"virtual_pointer":null,"virtual_keyboard":null,"screencopy":null,"wl_output_count":1}}\\n'; else printf '{"compositor":"unknown","globals":{"virtual_pointer":2,"virtual_keyboard":1,"screencopy":3,"foreign_toplevel_wlr":3,"wl_output_count":1}}\\n'; fi ;;
  windows) printf '[]\\n' ;;
  screenshot) printf '{"base64":"QUJD","width":1920,"height":1080}\\n' ;;
  pointer-move) printf '{"action":"move","x":%s,"y":%s}\\n' "$3" "$5" ;;
  *) exit 2 ;;
esac
`);
sh(join(bin, "xprop"), LOGLINE("xprop") + `
if [ "$1" = "-root" ]; then
  if [ "$DISPLAY" = ":93" ]; then printf '_NET_SUPPORTING_WM_CHECK:  no such atom on any window.\\n'; else printf '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x20010b\\n'; fi
else
  printf '_NET_WM_NAME(UTF8_STRING) = "Xfwm4"\\n'
fi
`);
sh(join(bin, "xclip"), "exit 0\n");
sh(join(bin, "Xvfb"), "exit 0\n");
writeFileSync(join(bin, "sway"), "not executable\n"); // present but not +x: not found

// Real Unix sockets: X97 X96 (targets), X98 (= Claude's own DISPLAY), a plain
// file X5 (not a socket: skipped); wayland-0 (own), wayland-5, wayland-weston,
// and a .lock file next to it.
const servers = [];
function sock(path) {
  return new Promise((r) => { const s = net.createServer(); s.listen(path, () => r()); servers.push(s); });
}
// A second runtime dir with its own wayland-0: same name, different socket.
const runtime2 = join(base, "run2");
mkdirSync(runtime2);
await sock(join(runtime2, "wayland-0"));
await Promise.all([join(x11Dir, "X97"), join(x11Dir, "X96"), join(x11Dir, "X98"),
  join(runtime, "wayland-0"), join(runtime, "wayland-5"), join(runtime, "wayland-weston")].map(sock));
writeFileSync(join(x11Dir, "X5"), "");
writeFileSync(join(runtime, "wayland-5.lock"), "");
// Aliases of Claude's own Wayland socket that a string compare misses: a
// symlinked directory (like /var/run -> ../run), a symlink to the socket
// itself, and /proc/self/root/<path>.
const runAlias = join(base, "run-alias");
symlinkSync(runtime, runAlias);
const ownLink = join(base, "own-link");
symlinkSync(join(runtime, "wayland-0"), ownLink);
// A third runtime dir as the NixOS background-display module leaves it: a
// stable-name symlink to the compositor's own socket (wayland-claude-extra ->
// wayland-1), plus a dangling symlink, a symlink to a plain file and a symlink
// to Claude's own socket.
const runtime3 = join(base, "run3");
mkdirSync(runtime3);
await Promise.all([join(runtime3, "wayland-0"), join(runtime3, "wayland-1")].map(sock));
symlinkSync("wayland-1", join(runtime3, "wayland-claude-extra"));
symlinkSync("wayland-gone", join(runtime3, "wayland-dangling"));
writeFileSync(join(runtime3, "plain"), "");
symlinkSync("plain", join(runtime3, "wayland-tofile"));
symlinkSync(join(runtime3, "wayland-0"), join(runtime3, "wayland-ownlink"));
const OWN_ALIASES = [
  ["x11", ":00"], ["x11", ":098"], ["x11", ":0098"],
  ["wlroots", join(runAlias, "wayland-0")], ["wlroots", ownLink], ["wlroots", "/proc/self/root" + join(runtime, "wayland-0")]
];

// Host session: X11 :98.0 (XWayland) + Wayland wayland-0, plus the variables
// that must never reach a target child.
Object.assign(process.env, {
  DISPLAY: ":98.0", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: runtime, PATH: bin,
  X11_BRIDGE_BIN: x11Fake, GDK_BACKEND: "wayland", QT_QPA_PLATFORM: "wayland",
  SWAYSOCK: "/run/host-sway.sock", HOSTVAR: "kept", XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "sway"
});
delete process.env.CLAUDE_CU_MODE;
delete process.env.WLROOTS_BRIDGE_BIN;
delete process.env.XAUTHORITY;
process.resourcesPath = res;

// --- load ----------------------------------------------------------------------
function load({ platform } = {}) {
  const src = readFileSync(GUARD_JS, "utf8") +
    readFileSync(MAIN_JS, "utf8").split('"/tmp/.X11-unix"').join(JSON.stringify(x11Dir));
  const dir = mkdtempSync(join(tmpdir(), "cdb-cubg-mod-"));
  const mod = join(dir, "extra.cjs");
  writeFileSync(mod, src);
  const handlers = {};
  const resized = [];
  const appEvents = {};
  const fakeElectron = {
    app: { getPath: () => userData, on: () => {}, once: (e, f) => { appEvents[e] = f; }, relaunch: () => {}, exit: () => {} },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} },
    shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} },
    nativeImage: {
      createFromBuffer: (buf) => ({
        isEmpty: () => buf.length === 0,
        getSize: () => ({ width: 1280, height: 800 }),
        resize: (o) => { resized.push(o); return { getSize: () => ({ width: o.width, height: 300 }), toJPEG: () => Buffer.from("thumb") }; },
        toJPEG: () => Buffer.from("full")
      })
    }
  };
  const Module = require2("module");
  const orig = Module._load;
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Module._load = function (req, ...rest) { return req === "electron" ? fakeElectron : orig.call(this, req, ...rest); };
  globalThis.__cdbDiag = () => {};
  try { require2(mod); } finally {
    Module._load = orig;
    if (platform) Object.defineProperty(process, "platform", origPlatform);
  }
  const ev = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
  const call = async (ch, ...args) => {
    if (!handlers[ch]) return { ok: false, error: "no handler for " + ch, missing: true };
    return await handlers[ch](ev, ...args);
  };
  const callAs = async (sender, ch, ...args) => {
    if (!handlers[ch]) return { ok: false, error: "no handler for " + ch, missing: true };
    return await handlers[ch](sender, ...args);
  };
  return { call, callAs, handlers, resized, ready: () => appEvents.ready && appEvents.ready() };
}

const jsonPath = join(userData, "claude-desktop-extra.json");
const jsoncPath = join(userData, "claude-desktop-extra.jsonc");
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const readJson = () => { try { return JSON.parse(readText(jsonPath)); } catch { return {}; } };
// A refusal only counts when the handler exists and answered it.
const refused = (r) => r && r.ok === false && !r.missing;
const log = () => readFileSync(logFile, "utf8");
const clearLog = () => writeFileSync(logFile, "");
const lines = (tag, sub) => log().split("\n").filter((l) => l.startsWith(tag + " " + sub));

const m = load();

section("registration");
const CH = ["read", "set", "candidates", "probe", "thumbnail", "test", "tools"].map((c) => "cdb-cubg:" + c);
ok(CH.every((c) => typeof m.handlers[c] === "function"), "all seven cdb-cubg channels are registered",
  CH.filter((c) => !m.handlers[c]).join(","));
ok(log() === "", "loading the module spawns nothing (nothing runs at startup)");

section("source: async only");
{
  const src = readFileSync(MAIN_JS, "utf8");
  ok(!/\b(execFileSync|spawnSync|execSync)\b/.test(src), "extra_settings_main.js has no execFileSync / spawnSync / execSync");
  // The background-display code itself: helpers and handlers. The one sync
  // step allowed is the shared writer __cdbEx_writeCfg, called by name.
  const a = src.indexOf("// --- Computer Use on a background display (issue #300)");
  const b = src.indexOf("// --- handlers ---", a);
  const h1 = src.indexOf('"cdb-cubg:read"');
  const h2 = src.indexOf("// Open one of OUR files", h1);
  const cubg = a >= 0 && b > a && h1 >= 0 && h2 > h1 ? src.slice(a, b) + src.slice(h1, h2) : "";
  ok(cubg.length > 1000 && !/Sync\(/.test(cubg) && !/__cdbEx_readFileKey\(/.test(cubg),
    "no sync call (readFileSync, statSync, accessSync, ...) in the background-display helpers and handlers",
    (cubg.match(/\w*Sync\(|__cdbEx_readFileKey\(/g) || []).join(","));
  ok(/execFile\(/.test(src) && /var tmo = timeoutMs \|\| __cdbEx_CUBG_TIMEOUT_MS;/.test(src) && /timeout: tmo, killSignal: "SIGKILL"/.test(src) && /__cdbEx_CUBG_TIMEOUT_MS = 5000;/.test(src),
    "children are async execFile with a 5 s timeout");
}

section("bridge wrappers");
{
  const calls = [];
  let exposed = null;
  const sandbox = {
    require: () => ({
      contextBridge: { exposeInMainWorld: (n, api) => { exposed = api; } },
      ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); } }
    }),
    console
  };
  vm.runInNewContext(readFileSync(BRIDGE_JS, "utf8"), vm.createContext(sandbox));
  const api = exposed || {};
  const names = ["cuBackgroundRead", "cuBackgroundSet", "cuBackgroundCandidates", "cuBackgroundProbe",
    "cuBackgroundThumbnail", "cuBackgroundTest", "cuBackgroundTools"];
  ok(names.every((n) => typeof api[n] === "function"), "the bridge exposes every cuBackground* method",
    names.filter((n) => typeof api[n] !== "function").join(","));
  if (names.every((n) => typeof api[n] === "function")) {
    api.cuBackgroundSet({ enabled: true, kind: "x11", display: ":97", env: { LD_PRELOAD: "/evil.so" }, extra: 1 });
    ok(calls[0][0] === "cdb-cubg:set" && JSON.stringify(calls[0][1]) === '{"enabled":true,"kind":"x11","display":":97"}',
      "set forwards {enabled, kind, display} only - never env", JSON.stringify(calls[0]));
    calls.length = 0;
    api.cuBackgroundRead(); api.cuBackgroundCandidates(); api.cuBackgroundProbe("x11", ":97");
    api.cuBackgroundThumbnail("wlroots", "wayland-5"); api.cuBackgroundTest(); api.cuBackgroundTools();
    ok(calls.map((c) => c[0]).join(" ") ===
      "cdb-cubg:read cdb-cubg:candidates cdb-cubg:probe cdb-cubg:thumbnail cdb-cubg:test cdb-cubg:tools",
      "every method hits its fixed channel");
    ok(calls[2][1] === "x11" && calls[2][2] === ":97" && calls[4][1] === "" && calls[4][2] === "",
      "probe/test arguments are stringified (empty = configured)");
  }
}

section("candidates");
{
  const r = await m.call("cdb-cubg:candidates");
  const c = r.candidates || [];
  const ids = c.map((x) => x.kind + ":" + x.display);
  ok(r.ok === true, "candidates answers ok", JSON.stringify(r));
  ok(JSON.stringify(ids) === JSON.stringify(["x11::96", "x11::97", "x11::98", "wlroots:wayland-0", "wlroots:wayland-5", "wlroots:wayland-weston"]),
    "X<n> sockets -> :n and wayland-* sockets, sorted; plain file X5 and wayland-5.lock skipped", JSON.stringify(ids));
  const own = c.filter((x) => x.own);
  ok(own.length === 2 && own.every((x) => x.selectable === false && x.label === "your desktop") &&
    own.map((x) => x.display).join(",") === ":98,wayland-0",
    "Claude's own DISPLAY (:98.0) and WAYLAND_DISPLAY are marked \"your desktop\", not selectable", JSON.stringify(own));
  ok(c.length > 0 && c.filter((x) => !x.own).every((x) => x.selectable === true), "every other candidate is selectable");
  ok(r.own && r.own.display === ":98" && r.own.wayland === "wayland-0", "own display reported top-level");
  ok(log() === "" && r.ok === true, "listing candidates spawns nothing");
}

section("read / set: the settings contract");
{
  let r = await m.call("cdb-cubg:read");
  ok(r.ok && r.present === false && r.enabled === false && r.lockedByJsonc === null && r.source === "default" && r.valid === true,
    "absent key -> off, not locked", JSON.stringify(r));

  r = await m.call("cdb-cubg:set", { enabled: true });
  ok(refused(r) && !existsSync(jsonPath), "enabling without a display is refused and writes nothing", JSON.stringify(r));

  r = await m.call("cdb-cubg:set", { enabled: true, kind: "x11", display: ":98" });
  ok(refused(r) && r.own === true && !existsSync(jsonPath), "Claude's own display cannot be saved", JSON.stringify(r));
  r = await m.call("cdb-cubg:set", { enabled: true, kind: "wlroots", display: join(runtime, "wayland-0") });
  ok(refused(r) && r.own === true, "own Wayland socket by absolute path cannot be saved either", JSON.stringify(r));

  for (const [kind, display] of [["x11", ":97; rm -rf ~"], ["x11", "wayland-5"], ["wlroots", ":97"], ["gnome", ":97"],
    ["wlroots", "wayland-5.lock"], ["wlroots", "/run/../etc/passwd"], ["wlroots", "relative/sock"]]) {
    r = await m.call("cdb-cubg:set", { enabled: true, kind, display });
    ok(refused(r) && !existsSync(jsonPath), `invalid target refused: ${kind} ${display}`, JSON.stringify(r));
  }

  r = await m.call("cdb-cubg:set", { enabled: true, kind: "x11", display: ":97", env: { LD_PRELOAD: "/evil.so" } });
  ok(r.ok === true && r.config && r.config.display === ":97", "a valid x11 target is saved", JSON.stringify(r));
  ok(readText(jsonPath) === JSON.stringify({ [KEY]: { enabled: true, kind: "x11", display: ":97" } }, null, 2) + "\n",
    "the .json holds exactly {enabled, kind, display} - env from the page is ignored", readText(jsonPath));

  r = await m.call("cdb-cubg:set", { enabled: false });
  ok(r.ok && JSON.stringify(readJson()[KEY]) === '{"enabled":false,"kind":"x11","display":":97"}',
    "switching off alone keeps the chosen display", JSON.stringify(readJson()));
  r = await m.call("cdb-cubg:set", { enabled: true });
  ok(r.ok && (readJson()[KEY] || {}).enabled === true, "switching back on alone reuses it");

  r = await m.call("cdb-cubg:set", { enabled: true, kind: "wlroots", display: "wayland-5" });
  ok(r.ok && JSON.stringify(readJson()[KEY]) === '{"enabled":true,"kind":"wlroots","display":"wayland-5"}', "a wlroots socket name is saved");
  r = await m.call("cdb-cubg:set", { enabled: true, kind: "wlroots", display: "/tmp/xx.AbC/wayland-1" });
  ok(r.ok && (readJson()[KEY] || {}).display === "/tmp/xx.AbC/wayland-1", "an absolute wlroots socket path is saved");

  // Other keys in the .json survive; a hand-written env map is kept verbatim.
  writeFileSync(jsonPath, JSON.stringify({ themePicker: false, [KEY]: { enabled: false, kind: "x11", display: ":97", env: { XAUTHORITY: "/tmp/xa" } } }));
  r = await m.call("cdb-cubg:set", { enabled: true, kind: "x11", display: ":97" });
  const j = readJson();
  ok(r.ok && j.themePicker === false && JSON.stringify(j[KEY]) === '{"enabled":true,"kind":"x11","display":":97","env":{"XAUTHORITY":"/tmp/xa"}}',
    "other keys survive and a hand-written env map is kept", JSON.stringify(j));
  r = await m.call("cdb-cubg:read");
  ok(r.ok && r.enabled && r.valid && r.config.display === ":97" && JSON.stringify(r.envKeys) === '["XAUTHORITY"]' && !("env" in r.config),
    "read returns the config and env key names, never env values", JSON.stringify(r));

  // A broken value can always be switched off (the revert path).
  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: true, kind: "gnome", display: 7 } }));
  r = await m.call("cdb-cubg:read");
  ok(r.ok && r.enabled === true && r.valid === false && r.config === null && /kind/.test(r.error || ""),
    "enabled but invalid reads as on + invalid (fail-closed case shown)", JSON.stringify(r));
  r = await m.call("cdb-cubg:set", { enabled: false });
  ok(r.ok && (readJson()[KEY] || {}).enabled === false, "an invalid value can still be switched off", JSON.stringify(readJson()));
}

section("env validation");
{
  const cases = [
    [{ PATH: "/evil" }, /PATH/], [{ CLAUDE_ELECTRON: "/evil" }, /CLAUDE_ELECTRON/], [{ LD_PRELOAD: "/e.so" }, /LD_PRELOAD/],
    [{ LD_LIBRARY_PATH: "/e" }, /LD_LIBRARY_PATH/], [{ XAUTHORITY: 5 }, /string/], [{ "BAD-NAME": "x" }, /variable name/], [["X=1"], /object/]
  ];
  for (const [env, re] of cases) {
    writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: true, kind: "x11", display: ":97", env } }));
    const r = await m.call("cdb-cubg:read");
    ok(r.ok && r.valid === false && re.test(r.error || ""), "env rejected: " + JSON.stringify(env), JSON.stringify(r));
  }
  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: true, kind: "x11", display: ":97",
    env: { XAUTHORITY: "/tmp/xa", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/b" } } }));
  const r = await m.call("cdb-cubg:read");
  ok(r.ok && r.valid === true, "env with XAUTHORITY / DBUS_SESSION_BUS_ADDRESS is accepted", JSON.stringify(r));
}

section("lockedByJsonc");
{
  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: false, kind: "x11", display: ":96" } }));
  writeFileSync(jsoncPath, '{\n  // set by my NixOS module\n  "' + KEY + '": { "enabled": true, "kind": "x11", "display": ":97", },\n}\n');
  let r = await m.call("cdb-cubg:read");
  ok(r.ok && r.lockedByJsonc === true && r.source === "jsonc" && r.config.display === ":97" && r.enabled === true && r.path === jsoncPath,
    "a .jsonc key locks the row and wins over the .json", JSON.stringify(r));
  const before = readText(jsonPath);
  r = await m.call("cdb-cubg:set", { enabled: false });
  ok(refused(r) && r.lockedByJsonc === true && readText(jsonPath) === before,
    "set refuses while locked and leaves the .json untouched", JSON.stringify(r));
  writeFileSync(jsoncPath, '{ "' + KEY + '": "garbage" }');
  r = await m.call("cdb-cubg:read");
  ok(r.ok && r.lockedByJsonc === true && r.enabled === false && r.valid === true && r.config === null,
    "a non-object .jsonc value is OFF like the executor reads it, and still owns the key (locked)", JSON.stringify(r));
  writeFileSync(jsoncPath, "{}\n");
}

section("probe");
{
  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: true, kind: "x11", display: ":97", env: { XAUTHORITY: "/tmp/xa" } } }));
  clearLog();
  let r = await m.call("cdb-cubg:probe", "x11", ":97");
  ok(r.ok && r.running === true && r.supported === true && r.reason === null && r.configured === true,
    "x11 :97 -> running, supported, configured", JSON.stringify(r));
  ok(r.size && r.size.width === 1280 && r.size.height === 800 && r.screens.length === 1 && r.screens[0].primary === true,
    "screens/size come from bridge `screens`", JSON.stringify(r.screens));
  ok(r.windows === 2, "windows count from bridge `windows`");
  ok(r.wm && r.wm.present === true && r.wm.name === "Xfwm4" && r.wm.via === "xprop", "WM found via _NET_SUPPORTING_WM_CHECK", JSON.stringify(r.wm));
  ok(r.clipboard && r.clipboard.tool === "xclip", "clipboard tool xclip detected on PATH");
  ok(Array.isArray(r.singleInstance) && Array.isArray(r.restrictions) &&
    r.restrictions.every((x) => typeof x.id === "string" && typeof x.text === "string") &&
    r.restrictions.some((x) => x.id === "teach") && !r.restrictions.some((x) => x.id === "no-wm" || x.id === "no-clipboard"),
    "restrictions: {id,text}[] with teach, no WM/clipboard complaint", JSON.stringify(r.restrictions));
  ok(typeof r.ms === "number", "probe reports its duration");
  const subs = lines("x11", "").map((l) => l.split(" ")[1]);
  ok(["screens", "doctor", "windows"].every((s) => subs.includes(s)) && !subs.includes("screenshot") && !subs.includes("pointer-move"),
    "probe runs screens + doctor + windows, no screenshot or input", subs.join(","));
  const envOk = log().trim() !== "" && log().split("\n").filter(Boolean).every((l) =>
    / D=:97 /.test(l) && / W=unset /.test(l) && / T=x11 /.test(l) && / G=unset /.test(l) && / Q=unset /.test(l) &&
    / S=unset /.test(l) && / H=kept /.test(l) && / XA=\/tmp\/xa$/.test(l));
  ok(envOk, "children get DISPLAY=:97, no WAYLAND_DISPLAY/GDK_BACKEND/QT_QPA_PLATFORM/SWAYSOCK, XDG_SESSION_TYPE=x11, the configured env overlay, the rest inherited", log());

  clearLog();
  r = await m.call("cdb-cubg:probe", "x11", ":93");
  ok(r.ok && r.supported === true && r.configured === false && r.wm.present === false && r.restrictions.some((x) => x.id === "no-wm"),
    "no WM on :93 -> no-wm restriction", JSON.stringify(r.wm));
  ok(log().trim() !== "" && log().split("\n").filter(Boolean).every((l) => / XA=unset$/.test(l)), "the env overlay applies to the configured display only");

  r = await m.call("cdb-cubg:probe", "x11", ":96");
  ok(r.ok && r.running === false && r.supported === false && /not running/.test(r.reason || "") && /Connection refused/.test(r.reason || ""),
    "stale socket :96 -> not running with the bridge's reason", JSON.stringify(r));
  r = await m.call("cdb-cubg:probe", "x11", ":95");
  ok(r.ok && r.running === true && r.supported === false && /XTEST/.test(r.reason || ""), "no XTEST -> unsupported", r.reason);

  clearLog();
  r = await m.call("cdb-cubg:probe", "wlroots", "wayland-5");
  ok(r.ok && r.running && r.supported && r.size.width === 1920 && r.wm.present === true && r.windows === 0,
    "wlroots wayland-5 via the bundled resources/ bridge -> supported", JSON.stringify(r));
  ok(r.ok && r.clipboard.tool === null && r.restrictions.some((x) => x.id === "no-clipboard"), "no wl-copy -> no-clipboard restriction");
  const wl = log().split("\n").filter(Boolean);
  ok(wl.length >= 3 && wl.every((l) => l.startsWith("wlr ") && / W=wayland-5 /.test(l) && / D=unset /.test(l) && / T=wayland /.test(l) && / S=unset /.test(l)),
    "wlroots children get WAYLAND_DISPLAY=wayland-5, no DISPLAY, no host SWAYSOCK", wl.join("\n"));
  r = await m.call("cdb-cubg:probe", "wlroots", "wayland-weston");
  ok(r.ok && r.running && r.supported === false && (r.missing || []).includes && r.missing.includes("zwlr_virtual_pointer_v1") && /weston/.test(r.reason || ""),
    "a compositor without virtual-pointer/screencopy is unsupported with the reason", JSON.stringify(r));

  clearLog();
  for (const [k, d] of [["x11", ":98"], ["wlroots", "wayland-0"], ["wlroots", join(runtime, "wayland-0")]]) {
    r = await m.call("cdb-cubg:probe", k, d);
    ok(refused(r) && r.own === true, "probe refuses Claude's own display " + d, JSON.stringify(r));
  }
  for (const [k, d] of [["gnome", ":97"], ["x11", ":97 -o"], ["wlroots", "../wayland-1"], ["wlroots", "wayland-5.lock"], ["x11", ""]]) {
    r = await m.call("cdb-cubg:probe", k, d);
    ok(refused(r) && !r.own, "probe refuses invalid target " + k + " " + JSON.stringify(d), JSON.stringify(r));
  }
  ok(log() === "" && m.handlers["cdb-cubg:probe"], "no bridge ran for an own or invalid display", log());
}

section("thumbnail / test / tools");
{
  clearLog();
  let r = await m.call("cdb-cubg:thumbnail", "x11", ":97");
  ok(r.ok && r.dataUrl === "data:image/jpeg;base64," + Buffer.from("thumb").toString("base64") && r.width === 480 &&
    r.sourceWidth === 1280 && m.resized.some((o) => o.width === 480),
    "thumbnail: bridge screenshot downscaled to 480 px through nativeImage", JSON.stringify(r));
  ok(lines("x11", "screenshot").length === 1, "thumbnail runs exactly one bridge screenshot");
  r = await m.call("cdb-cubg:thumbnail", "x11", ":98");
  ok(refused(r) && r.own === true, "no thumbnail of Claude's own desktop");
  r = await m.call("cdb-cubg:thumbnail", "x11", ":96");
  ok(refused(r) && /screenshot failed/.test(r.error || ""), "thumbnail of a dead display fails with the reason", JSON.stringify(r));

  clearLog();
  r = await m.call("cdb-cubg:test", "x11", ":97");
  ok(r.ok === true && r.steps.map((s) => s.name).join(",") === "screens,screenshot,pointer-move" && r.steps.every((s) => s.ok) && r.dataUrl,
    "test: screens + screenshot + pointer-move all ok", JSON.stringify(r));
  ok(lines("x11", "pointer-move").some((l) => l.startsWith("x11 pointer-move --x 640 --y 400 D=:97 ")),
    "test moves the pointer to the middle of :97", log());
  clearLog();
  r = await m.call("cdb-cubg:test", "", "");
  ok(r.ok === true && r.display === ":97" && lines("x11", "pointer-move").length === 1, "test without arguments uses the configured display", JSON.stringify(r));
  r = await m.call("cdb-cubg:test", "x11", ":96");
  ok(refused(r) && r.steps && r.steps.length === 1 && r.steps[0].ok === false && /not running/.test(r.error || ""),
    "test on a dead display stops after screens", JSON.stringify(r));

  r = await m.call("cdb-cubg:tools");
  ok(r.ok && r.tools.Xvfb === join(bin, "Xvfb") && r.tools.xclip === join(bin, "xclip") && r.tools.sway === null &&
    r.tools.wayvnc === null && "x11vnc" in r.tools && "Xephyr" in r.tools && "labwc" in r.tools && "openbox" in r.tools &&
    "i3" in r.tools && "xfwm4" in r.tools && "wl-copy" in r.tools,
    "tools: PATH lookup without spawning (non-executable sway = absent)", JSON.stringify(r.tools));
}

section("never blocks");
{
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 100);
  const t0 = Date.now();
  const r = await m.call("cdb-cubg:probe", "x11", ":94");
  const ms = Date.now() - t0;
  clearInterval(iv);
  ok(r.ok && r.running === false && /no answer within 5 s/.test(r.reason || ""), "a hanging bridge is killed at the 5 s timeout", JSON.stringify(r));
  ok(ms >= 4500 && ms < 8000, "the probe returns at the timeout", ms + " ms");
  ok(ticks >= 30, "the event loop kept running while the bridge hung", ticks + " ticks");
}

section("own display: aliases, switched off, env on change, foreign sender");
{
  writeFileSync(jsonPath, "{}");
  writeFileSync(jsoncPath, "{}\n");
  clearLog();
  for (const [k, d] of OWN_ALIASES) {
    const pr = await m.call("cdb-cubg:probe", k, d);
    const th = await m.call("cdb-cubg:thumbnail", k, d);
    const te = await m.call("cdb-cubg:test", k, d);
    const se = await m.call("cdb-cubg:set", { enabled: true, kind: k, display: d });
    const off = await m.call("cdb-cubg:set", { enabled: false, kind: k, display: d });
    ok(refused(pr) && refused(th) && refused(te) && refused(se) && refused(off),
      "alias of Claude's own display refused by probe, thumbnail, test and set (on and off): " + k + " " + d,
      JSON.stringify([pr, th, te, se, off].map((r) => r && r.error)));
    if (k === "wlroots") ok(pr.own === true && se.own === true && off.own === true, "  and recognised as the own socket: " + d, JSON.stringify(pr));
  }
  ok(log() === "", "no bridge ran for any alias", log());
  ok(JSON.stringify(readJson()) === "{}", "nothing was saved for any alias", readText(jsonPath));

  let r = await m.call("cdb-cubg:set", { enabled: false, kind: "x11", display: ":98" });
  ok(refused(r) && r.own === true && JSON.stringify(readJson()) === "{}", "the own display is not saved even switched off", JSON.stringify(r));
  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: true, kind: "x11", display: ":98" } }));
  r = await m.call("cdb-cubg:set", { enabled: false });
  ok(r.ok === true && r.ownRemoved === true && !(KEY in readJson()), "a hand-written own display is removed when switched off (absent = off)", readText(jsonPath));
  r = await m.call("cdb-cubg:set", { enabled: true, kind: "wlroots", display: "/" + "a".repeat(300) });
  ok(refused(r), "a socket path over 255 characters is refused");

  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: true, kind: "x11", display: ":97", env: { XAUTHORITY: "/tmp/xa" } } }));
  r = await m.call("cdb-cubg:set", { enabled: true, kind: "x11", display: ":97" });
  ok(r.ok && r.envDropped === false && (readJson()[KEY] || {}).env && readJson()[KEY].env.XAUTHORITY === "/tmp/xa",
    "same display: the env map is kept", readText(jsonPath));
  r = await m.call("cdb-cubg:set", { enabled: true, kind: "x11", display: ":96" });
  ok(r.ok && r.envDropped === true && JSON.stringify(readJson()[KEY]) === '{"enabled":true,"kind":"x11","display":":96"}',
    "display changed through the page: env dropped and reported", JSON.stringify(r) + " " + readText(jsonPath));

  const foreign = [
    { sender: { isDestroyed: () => false, getURL: () => "https://evil.example.com/" }, senderFrame: { parent: null } },
    { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai.evil.example.com/" }, senderFrame: { parent: null } },
    { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: {} } }
  ];
  clearLog();
  const before = readText(jsonPath);
  let allRejected = true;
  for (const ev of foreign) {
    for (const ch of CH) {
      const fr = await m.callAs(ev, ch, ch === "cdb-cubg:set" ? { enabled: true, kind: "x11", display: ":97" } : "x11", ":97");
      if (!(fr && fr.ok === false && /unrecognized sender/.test(fr.error || ""))) { allRejected = false; console.error("    " + ch + " " + JSON.stringify(fr)); }
    }
  }
  ok(allRejected && log() === "" && readText(jsonPath) === before,
    "a foreign origin or a subframe is rejected on every cdb-cubg channel, nothing runs or is written");
}

{
  // Screenshots: one in flight per display, shared by concurrent callers,
  // keyed on the display itself, and at most one per 2 s.
  writeFileSync(jsonPath, "{}");
  clearLog();
  const [t1, t2] = await Promise.all([m.call("cdb-cubg:thumbnail", "x11", ":93"), m.call("cdb-cubg:thumbnail", "x11", ":93")]);
  ok(t1.ok && t2.ok && lines("x11", "screenshot").length === 1, "two concurrent previews of one display share one screenshot",
    String(lines("x11", "screenshot").length));
  const t3 = await m.call("cdb-cubg:thumbnail", "x11", ":93");
  ok(t3.ok && t3.cached === true && lines("x11", "screenshot").length === 1, "a preview inside 2 s gets the last result, no new capture", JSON.stringify(t3));
  const te = await m.call("cdb-cubg:test", "x11", ":93");
  ok(te.ok && lines("x11", "screenshot").length === 1 && /under 2 s ago/.test(te.steps[1].detail), "Test inside 2 s reuses it too and says so", JSON.stringify(te.steps));
  clearLog();
  const spell = await Promise.all(["wayland-5", join(runtime, "wayland-5"), join(runAlias, "wayland-5")]
    .map((d) => m.call("cdb-cubg:thumbnail", "wlroots", d)));
  ok(spell.every((r) => r.ok) && lines("wlr", "screenshot").length === 1,
    "three spellings of one Wayland socket share one screenshot (keyed on dev+ino)", lines("wlr", "screenshot").length + " " + JSON.stringify(spell));
}

{
  // Unstatable own socket: not provable that a target is another display.
  const ownWl = process.env.WAYLAND_DISPLAY;
  process.env.WAYLAND_DISPLAY = "wayland-gone";
  clearLog();
  const pr = await m.call("cdb-cubg:probe", "wlroots", "wayland-5");
  const se = await m.call("cdb-cubg:set", { enabled: true, kind: "wlroots", display: "wayland-5" });
  process.env.WAYLAND_DISPLAY = ownWl;
  ok(refused(pr) && /cannot tell whether wayland-5 is your own desktop/.test(pr.error || "") && refused(se) && log() === "",
    "Claude's own Wayland socket unstatable -> wlroots targets refused, nothing runs", JSON.stringify([pr, se]));
}

{
  // A full queue is "busy", never "not supported" (6 running + 48 queued).
  clearLog();
  const all = await Promise.all(Array.from({ length: 60 }, () => m.call("cdb-cubg:probe", "x11", ":92")));
  const busy = all.filter((r) => r.busy === true);
  ok(busy.length === 6 && busy.every((r) => r.ok && r.supported === null && r.running === null && /busy/.test(r.reason || "")),
    "probes over the queue cap answer busy (supported:null), not 'not supported'", busy.length + " " + JSON.stringify(busy[0]));
  ok(all.filter((r) => !r.busy).every((r) => r.running === false), "the queued ones still ran");

  // The same when the queue fills between `screens` and `doctor`/`windows`:
  // :90's screens holds a slot, 55 held fillers take the other 5 slots and
  // all 48 queue places (2 refused); releasing :90 frees one slot (a filler
  // moves up), doctor takes the last queue place, windows is refused.
  clearLog();
  const waitFor = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); return fn(); };
  const p90 = m.call("cdb-cubg:probe", "x11", ":90");
  await waitFor(() => lines("x11", "screens").some((l) => / D=:90 /.test(l)));
  let refusedFillers = 0;
  const fillers = Array.from({ length: 55 }, () => m.call("cdb-cubg:probe", "x11", ":88").then((r) => { if (r.busy) refusedFillers++; return r; }));
  const filled = await waitFor(() => refusedFillers === 2 && lines("x11", "screens").filter((l) => / D=:88 /.test(l)).length === 5);
  writeFileSync(join(base, "release-90"), "");
  await waitFor(() => lines("x11", "doctor").some((l) => / D=:90 /.test(l)) || lines("x11", "screens").filter((l) => / D=:88 /.test(l)).length > 5);
  writeFileSync(join(base, "release-88"), "");
  const r90 = await p90;
  await Promise.all(fillers);
  ok(filled && r90.ok && r90.running === true && r90.busy === true && r90.supported === null && /busy/.test(r90.reason || ""),
    "a queue refusal after screens (doctor/windows) reads busy, never 'not supported'", filled + " " + JSON.stringify(r90));
}

section("unreadable .jsonc, own display in env, IPv6 DISPLAY (spec ruling T4 review, MED)");
{
  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: false, kind: "x11", display: ":97" } }));
  // Broken AND naming our key: the user meant to set it -> on + invalid + locked.
  for (const bad of ['{ "' + KEY + '": { "enabled": true, ', '["' + KEY + '"]']) {
    writeFileSync(jsoncPath, bad);
    const r = await m.call("cdb-cubg:read");
    ok(r.ok && r.enabled === true && r.valid === false && /jsonc cannot be parsed/.test(r.error || "") && /refused/.test(r.error || "") &&
      r.lockedByJsonc === true && r.config === null,
      "a broken .jsonc that names the key reads as on + invalid + locked, never the .json value: " + JSON.stringify(bad), JSON.stringify(r));
    const w = await m.call("cdb-cubg:set", { enabled: false });
    ok(refused(w) && w.lockedByJsonc === true && /jsonc cannot be parsed/.test(w.error || ""), "  and set refuses with the reason", JSON.stringify(w));
  }
  // Broken WITHOUT our key: absent, like every other row - the .json decides.
  for (const bad of ['{ "themePicker": false, ', "[1, 2]"]) {
    writeFileSync(jsoncPath, bad);
    const r = await m.call("cdb-cubg:read");
    ok(r.ok && r.enabled === false && r.valid === true && r.lockedByJsonc === null && r.source === "json" && r.config && r.config.display === ":97",
      "a broken .jsonc that never names the key is absent; the .json value shows: " + JSON.stringify(bad), JSON.stringify(r));
    const w = await m.call("cdb-cubg:set", { enabled: false });
    ok(w.ok === true, "  and the row stays writable", JSON.stringify(w));
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    writeFileSync(jsoncPath, '{ "' + KEY + '": { "enabled": true, "kind": "x11", "display": ":96" } }\n');
    chmodSync(jsoncPath, 0o000);
    const r = await m.call("cdb-cubg:read");
    chmodSync(jsoncPath, 0o644);
    ok(r.ok && r.enabled === false && r.lockedByJsonc === null && /could not be read \(EACCES\)/.test(r.note || ""),
      "an unreadable .jsonc (EACCES) reads as off with a note", JSON.stringify(r));
  }
  writeFileSync(jsoncPath, "{}\n");

  const cases = [
    [{ kind: "x11", display: ":97", env: { WAYLAND_DISPLAY: "wayland-0" } }, /env WAYLAND_DISPLAY wayland-0 is your own desktop/],
    [{ kind: "x11", display: ":97", env: { WAYLAND_DISPLAY: join(runAlias, "wayland-0") } }, /env WAYLAND_DISPLAY .* is your own desktop/],
    [{ kind: "x11", display: ":97", env: { XDG_RUNTIME_DIR: runAlias, WAYLAND_DISPLAY: "wayland-0" } }, /env WAYLAND_DISPLAY wayland-0 is your own desktop/],
    [{ kind: "wlroots", display: "wayland-5", env: { DISPLAY: ":98.0" } }, /env DISPLAY :98\.0 is your own desktop/],
    [{ kind: "wlroots", display: "wayland-5", env: { DISPLAY: "localhost:98" } }, /env DISPLAY localhost:98 is your own desktop/],
    [{ kind: "wlroots", display: "wayland-0", env: { XDG_RUNTIME_DIR: runAlias } }, /wayland-0 is your own desktop/],
    [{ kind: "x11", display: ":98" }, /:98 is your own desktop/]
  ];
  for (const [cfg, re] of cases) {
    writeFileSync(jsonPath, JSON.stringify({ [KEY]: Object.assign({ enabled: true }, cfg) }));
    const r = await m.call("cdb-cubg:read");
    ok(r.ok && r.enabled === true && r.valid === false && re.test(r.error || ""), "own display via the stored config is invalid: " + JSON.stringify(cfg), JSON.stringify(r));
  }
  for (const cfg of [
    { kind: "x11", display: ":97", env: { XDG_RUNTIME_DIR: runtime2, WAYLAND_DISPLAY: "wayland-0" } },
    { kind: "wlroots", display: "wayland-0", env: { XDG_RUNTIME_DIR: runtime2 } },
    { kind: "x11", display: ":97", env: { DISPLAY: ":97" } }
  ]) {
    writeFileSync(jsonPath, JSON.stringify({ [KEY]: Object.assign({ enabled: true }, cfg) }));
    const r = await m.call("cdb-cubg:read");
    ok(r.ok && r.valid === true, "a different display through the env map stays valid: " + JSON.stringify(cfg), JSON.stringify(r));
  }

  const hostDisplay = process.env.DISPLAY;
  for (const d of ["[::1]:98", "::1:98", "host::98", "[::1]:98.0"]) {
    process.env.DISPLAY = d;
    const c = await m.call("cdb-cubg:candidates");
    const own = (c.candidates || []).filter((x) => x.own && x.kind === "x11").map((x) => x.display).join(",");
    const pr = await m.call("cdb-cubg:probe", "x11", ":98");
    ok(own === ":98" && refused(pr) && pr.own === true, "own DISPLAY " + d + " parses to :98 (candidate marked, probe refused)", own + " " + JSON.stringify(pr));
  }
  process.env.DISPLAY = hostDisplay;
  writeFileSync(jsonPath, "{}");
}

section("startedWith: restart row on a kwin session");
{
  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: false, kind: "x11", display: ":97" } }));
  const a = load();
  a.ready();
  // The start read is async: wait until it has landed (bounded), never a fixed sleep.
  for (let i = 0; i < 200; i++) {
    const w = await a.call("cdb-cubg:read");
    if (w.startedWith && w.startedWith.enabled !== null) break;
  }
  writeFileSync(jsonPath, JSON.stringify({ [KEY]: { enabled: true, kind: "x11", display: ":97" } }));
  let r = await a.call("cdb-cubg:read");
  ok(r.ok && r.enabled === true && r.startedWith && r.startedWith.enabled === false && r.startedWith.restartOnChange === false,
    "startedWith is the value at ready, not the current one; no restart owed off KDE", JSON.stringify(r.startedWith));
  globalThis.__cuKwinMode = true;
  r = await a.call("cdb-cubg:read");
  ok(r.startedWith.kwinMode === true && r.startedWith.restartOnChange === true, "started in kwin mode -> a flip owes a restart", JSON.stringify(r.startedWith));
  delete globalThis.__cuKwinMode;

  const b = load();
  b.ready();
  for (let i = 0; i < 200; i++) {
    const w = await b.call("cdb-cubg:read");
    if (w.startedWith && w.startedWith.enabled !== null) break;
  }
  process.env.XDG_CURRENT_DESKTOP = "KDE";
  r = await b.call("cdb-cubg:read");
  ok(r.startedWith.enabled === true && r.startedWith.kdeWayland === true && r.startedWith.restartOnChange === true,
    "started ON on KDE Wayland (kwin probe skipped) -> a flip owes a restart", JSON.stringify(r.startedWith));
  process.env.CLAUDE_CU_MODE = "regular";
  r = await b.call("cdb-cubg:read");
  ok(r.startedWith.restartOnChange === false, "unless CLAUDE_CU_MODE pins the regular executor", JSON.stringify(r.startedWith));
  delete process.env.CLAUDE_CU_MODE;
  process.env.XDG_CURRENT_DESKTOP = "sway";
  r = await m.call("cdb-cubg:read");
  ok(r.startedWith && r.startedWith.enabled === null && r.startedWith.restartOnChange === false, "before ready: unknown, no restart claimed");
}

section("cross-reader contract: the panel's verdict == the executor's (js/cu_mode_preamble.js)");
{
  // The reader (+ identity check) spliced out of the preamble exactly as
  // scripts/tests/linux/test-cu-target-session.mjs does, run on the REAL temp
  // files and sockets with the real fs - so symlinks, EACCES and inodes are
  // the kernel's, not a stub's.
  const pre = readFileSync(PREAMBLE_JS, "utf8");
  const readerSrc = pre.match(/(?:if\(!globalThis\.__cuTargetIdentity\)[\s\S]*?\n  \};\n)?(?:  \/\/[^\n]*\n)*  if\(!globalThis\.__cuTargetRead\)globalThis\.__cuTargetRead=function\(\)\{[\s\S]*?\n  \};\n/);
  ok(!!readerSrc, "the executor's reader is found in the preamble");
  if (readerSrc) {
    const fsMod = require2("fs"), pathMod = require2("path");
    delete globalThis.__cuTargetRead; delete globalThis.__cuTargetIdentity; delete globalThis.__cuTgtJsoncDiag;
    new Function("_rp", "_rfs", "require", readerSrc[0])(pathMod, fsMod, (id) => {
      if (id === "electron") return { app: { getPath: () => userData } };
      throw new Error("unexpected require " + id);
    });
    // Both readers word an own-display refusal the same way; "cannot tell
    // whether ... is your own desktop" is an invalid, not an own verdict.
    const OWN_RE = /is your own desktop, not a background display/;
    const exec = () => {
      const t = globalThis.__cuTargetRead();
      if (!t) return "off";
      if (t.invalid) return OWN_RE.test(t.invalid) ? "own" : "invalid";
      return "valid " + t.kind + " " + t.display;
    };
    const panel = async () => {
      const r = await m.call("cdb-cubg:read");
      if (!r.ok) return "error " + r.error;
      if (!r.enabled) return "off";
      if (!r.valid) return OWN_RE.test(r.error || "") ? "own" : "invalid";
      return "valid " + r.config.kind + " " + r.config.display;
    };
    const both = async (label, want) => {
      const a = exec(), b = await panel();
      ok(a === b && (!want || a === want), "same verdict: " + label + " -> " + a, "executor=" + a + " panel=" + b + (want ? " want=" + want : ""));
    };
    const put = (json, jsonc) => {
      writeFileSync(jsonPath, json === undefined ? "{}" : typeof json === "string" ? json : JSON.stringify({ [KEY]: json }));
      writeFileSync(jsoncPath, jsonc === undefined ? "{}\n" : typeof jsonc === "string" ? jsonc : JSON.stringify({ [KEY]: jsonc }));
    };
    const X = (o) => Object.assign({ enabled: true, kind: "x11", display: ":97" }, o);
    const W = (o) => Object.assign({ enabled: true, kind: "wlroots", display: "wayland-5" }, o);

    // Written through the panel: env kept for the same display, dropped on a change.
    put({ enabled: false, kind: "x11", display: ":97", env: { XAUTHORITY: "/tmp/xa" } });
    await m.call("cdb-cubg:set", { enabled: true });
    await both("set: same display, env kept", "valid x11 :97");
    await m.call("cdb-cubg:set", { enabled: true, kind: "x11", display: ":96" });
    await both("set: display changed, env dropped", "valid x11 :96");
    await m.call("cdb-cubg:set", { enabled: false });
    await both("set: switched off", "off");

    const matrix = [
      ["env.DISPLAY own, x11 target (target var wins)", X({ env: { DISPLAY: ":98" } }), "valid x11 :97"],
      ["env.DISPLAY own, wlroots target", W({ env: { DISPLAY: ":98.0" } }), "own"],
      ["env.WAYLAND_DISPLAY own, x11 target", X({ env: { WAYLAND_DISPLAY: "wayland-0" } }), "own"],
      ["env.WAYLAND_DISPLAY own, wlroots target (target var wins)", W({ env: { WAYLAND_DISPLAY: "wayland-0" } }), "valid wlroots wayland-5"],
      ["env.WAYLAND_DISPLAY via env XDG_RUNTIME_DIR alias, x11", X({ env: { XDG_RUNTIME_DIR: runAlias, WAYLAND_DISPLAY: "wayland-0" } }), "own"],
      ["env.WAYLAND_DISPLAY not a socket, x11", X({ env: { WAYLAND_DISPLAY: join(runtime, "wayland-5.lock") } }), "valid x11 :97"],
      ["env.WAYLAND_DISPLAY missing, x11", X({ env: { WAYLAND_DISPLAY: "wayland-77" } }), "valid x11 :97"],
      ["relative target via env XDG_RUNTIME_DIR alias", W({ display: "wayland-0", env: { XDG_RUNTIME_DIR: runAlias } }), "own"],
      ["relative target via another runtime dir", W({ display: "wayland-0", env: { XDG_RUNTIME_DIR: runtime2 } }), "valid wlroots wayland-0"],
      ["symlinked dir to own socket", W({ display: join(runAlias, "wayland-0") }), "own"],
      ["symlink to own socket", W({ display: ownLink }), "own"],
      ["/proc/self/root alias of own socket", W({ display: "/proc/self/root" + join(runtime, "wayland-0") }), "own"],
      ["symlinked dir to another socket", W({ display: join(runAlias, "wayland-5") }), "valid wlroots " + join(runAlias, "wayland-5")],
      ["stable-name symlink to another socket", W({ display: "wayland-claude-extra", env: { XDG_RUNTIME_DIR: runtime3 } }), "valid wlroots wayland-claude-extra"],
      ["stable-name symlink to a plain file", W({ display: "wayland-tofile", env: { XDG_RUNTIME_DIR: runtime3 } }), "invalid"],
      ["wlroots socket not there yet", W({ display: "wayland-77" }), "valid wlroots wayland-77"],
      ["wlroots target not a socket", W({ display: join(runtime, "wayland-5.lock") }), "invalid"],
      ["x11 own", X({ display: ":98" }), "own"],
      ["x11 leading zero :098", X({ display: ":098" }), "invalid"],
      ["x11 leading zero :00", X({ display: ":00" }), "invalid"],
      ["env PATH", X({ env: { PATH: "/evil" } }), "invalid"],
      ["env LD_PRELOAD", X({ env: { LD_PRELOAD: "/e.so" } }), "invalid"],
      ["bad kind", X({ kind: "gnome" }), "invalid"],
      ["null value", null, "off"],
      ["string value", "garbage", "off"],
      ["number value", 5, "off"],
      ["true value", true, "off"],
      ["array value", [], "off"],
      ["enabled not a boolean", X({ enabled: "yes" }), "off"],
      ["enabled false with a broken rest", { enabled: false, kind: "gnome", display: 7 }, "off"]
    ];
    for (const [label, val, want] of matrix) {
      put(val);
      await both(".json: " + label, want);
    }
    for (const [label, val, want] of [["null in .jsonc over a valid .json", null, "off"], ["string in .jsonc", '{ "' + KEY + '": "x" }', "off"], ["own in .jsonc", X({ display: ":98" }), "own"]]) {
      put(X({}), val);
      await both(label, want);
    }
    put(X({}), '{ "' + KEY + '": { "enabled": true, ');
    await both("broken .jsonc naming the key", "invalid");
    put(X({}), '{ "themePicker": false, ');
    await both("broken .jsonc without the key -> the .json", "valid x11 :97");
    put(X({}), "[1, 2]");
    await both("non-object .jsonc without the key -> the .json", "valid x11 :97");
    put(X({}), '{ "' + KEY + '": { "enabled": false } }');
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      chmodSync(jsoncPath, 0o000);
      await both("unreadable .jsonc (EACCES) -> the .json", "valid x11 :97");
      chmodSync(jsoncPath, 0o644);
    }
    put("{ broken json", undefined);
    await both("broken .json", "off");

    const ownWl = process.env.WAYLAND_DISPLAY;
    process.env.WAYLAND_DISPLAY = "wayland-gone";
    put(W({}));
    await both("own Wayland socket unstatable, wlroots target", "invalid");
    put(X({ env: { WAYLAND_DISPLAY: "wayland-5" } }));
    await both("own Wayland socket unstatable, x11 target with env WAYLAND_DISPLAY", "invalid");
    put(X({}));
    await both("own Wayland socket unstatable, plain x11 target", "valid x11 :97");
    process.env.WAYLAND_DISPLAY = ownWl;
    const hostDisplay = process.env.DISPLAY;
    process.env.DISPLAY = "[::1]:98.0";
    put(X({ display: ":98" }));
    await both("IPv6 own DISPLAY", "own");
    process.env.DISPLAY = hostDisplay;
    delete globalThis.__cuTargetRead; delete globalThis.__cuTargetIdentity; delete globalThis.__cuTgtJsoncDiag;
  }
  writeFileSync(jsonPath, "{}");
  writeFileSync(jsoncPath, "{}\n");
}

section("candidates: stable-name symlinks (NixOS background display)");
{
  const hostRt = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime3;
  const r = await m.call("cdb-cubg:candidates");
  const wl = (r.candidates || []).filter((x) => x.kind === "wlroots");
  const ids = wl.map((x) => x.display);
  ok(JSON.stringify(ids) === JSON.stringify(["wayland-0", "wayland-1", "wayland-claude-extra", "wayland-ownlink"]),
    "a symlink to a socket is listed next to its target; dangling and to-a-file symlinks are not", JSON.stringify(ids));
  const link = wl.find((x) => x.display === "wayland-claude-extra");
  ok(!!link && link.selectable === true && link.own === false,
    "the stable name is selectable", JSON.stringify(link));
  const ownLinkRow = wl.find((x) => x.display === "wayland-ownlink");
  ok(!!ownLinkRow && ownLinkRow.own === true && ownLinkRow.selectable === false,
    "a symlink to Claude's own socket is listed as your desktop, not selectable", JSON.stringify(ownLinkRow));
  let s = await m.call("cdb-cubg:set", { enabled: true, kind: "wlroots", display: "wayland-claude-extra" });
  ok(s.ok === true && readJson()[KEY] && readJson()[KEY].display === "wayland-claude-extra",
    "the listed stable name is accepted when saved", JSON.stringify(s));
  s = await m.call("cdb-cubg:set", { enabled: true, kind: "wlroots", display: "wayland-tofile" });
  ok(refused(s) && /is not a Wayland socket/.test(s.error || ""), "a symlink to a plain file is refused when saved", JSON.stringify(s));
  s = await m.call("cdb-cubg:set", { enabled: true, kind: "wlroots", display: "wayland-ownlink" });
  ok(refused(s) && s.own === true, "a symlink to Claude's own socket is refused when saved", JSON.stringify(s));
  await m.call("cdb-cubg:set", { enabled: false });
  writeFileSync(jsonPath, "{}");
  process.env.XDG_RUNTIME_DIR = hostRt;
}

section("tool lookups under upstream's PATH narrowing (shared resolver)");
{
  // Since 4.23118 process.env.PATH is upstream's narrowed one; the lists come
  // from globalThis.__cdbToolPath (js/tool_path.js, tested in
  // test-tool-path-resolver): the TOOL PATH for what Computer Use or this page
  // runs (clipboard tools, xprop), the APP PATH for what the user starts from
  // the recipes. A stand-in resolver answers here.
  const toolDir = join(base, "tool-path"), appDir = join(base, "app-path");
  mkdirSync(toolDir, { recursive: true }); mkdirSync(appDir, { recursive: true });
  sh(join(toolDir, "wl-copy"), "exit 0\n"); sh(join(toolDir, "wl-paste"), "exit 0\n");
  sh(join(appDir, "sway"), "exit 0\n"); sh(join(appDir, "wl-copy"), "exit 0\n"); sh(join(appDir, "xprop"), "exit 0\n");
  const asked = [];
  globalThis.__cdbToolPath = {
    toolPath: () => { asked.push("tool"); return toolDir; },
    appPath: () => { asked.push("app"); return appDir; }
  };
  try {
    const r = await m.call("cdb-cubg:tools");
    ok(r.ok && r.tools["wl-copy"] === join(toolDir, "wl-copy") && r.tools["wl-paste"] === join(toolDir, "wl-paste"),
      "clipboard tools: looked up on the TOOL PATH (what the executor runs)", JSON.stringify(r.tools));
    ok(r.tools.xprop === null && r.tools.xclip === null,
      "xprop / xclip (run by us): not taken from the APP PATH or process.env.PATH", JSON.stringify(r.tools));
    ok(r.tools.sway === join(appDir, "sway") && r.tools.Xvfb === null,
      "recipe tools (the user starts them): looked up on the APP PATH", JSON.stringify(r.tools));
    ok(asked.includes("tool") && asked.includes("app"), "both lists come from the resolver", JSON.stringify(asked));
    globalThis.__cdbToolPath = { toolPath: () => null, appPath: () => null };
    const r2 = await m.call("cdb-cubg:tools");
    ok(r2.tools.Xvfb === join(bin, "Xvfb") && r2.tools.xclip === join(bin, "xclip"),
      "narrowing off (appPath null): process.env.PATH, as before", JSON.stringify(r2.tools));
  } finally {
    delete globalThis.__cdbToolPath;
  }
}

section("win32 build (downstream): channels refuse");
{
  const w = load({ platform: "win32" });
  const r = await w.call("cdb-cubg:candidates");
  ok(refused(r) && /Linux only/.test(r.error || ""), "on win32 the cdb-cubg channels answer a Linux-only refusal", JSON.stringify(r));
}

servers.forEach((s) => s.close());
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
