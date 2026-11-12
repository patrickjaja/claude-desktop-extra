// Regression test for the GNOME portal session lifecycle in js/cu_linux_executor.js.
//
// The CU lock hook (patches 4b / 4b.2 of fix_computer_use_linux.nim) calls
// __setLockHeld(true|false) FIRE-AND-FORGET on every lock transition. The portal
// session behind it is expensive to start: on GNOME the first session-start blocks
// on the XDG RemoteDesktop consent dialog. Two orderings have to hold or the
// gnome-portal-bridge daemon is left running, or a second consent dialog is raised:
//
//   A  a release that arrives while session-start is still pending must WAIT for
//      that start and then really end the session. Otherwise session-end runs
//      first, the start resolves afterwards and re-marks the session active with
//      no lock held - the daemon then survives to the process exit backstop.
//   B  a lock RE-ACQUIRED while a release is still awaiting that start must not
//      produce a second concurrent session-start. Otherwise two consent dialogs
//      are raised and the stale end tears down what the new lock asked for,
//      leaving _gnomeSessionActive true against a dead session.
//   C  the double release (4b.2 deliberately hooks both release and
//      releaseExclusive) must collapse to one teardown.
//
// The KDE twin in js/executor_linux.js has had both halves of this - a synchronous
// flag write plus a published stop promise that starts await - since it was
// written; this file is the GNOME side catching up. Run headless: the bridge is a
// stub, no portal and no GNOME needed.
//
// Cases 8-12 cover the default display: with no display selected, a screenshot
// targets the monitor `screens` marks is_shared (the portal session streams only
// what the user shared in the consent dialog), queried after session-start.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

process.setMaxListeners(50);                         // one exit hook per loaded executor
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR = path.join(ROOT, "js", "cu_linux_executor.js");

// session-start takes CONSENT_MS (the XDG RemoteDesktop dialog); everything else is instant.
// reply(sub, args) may return a string (stdout) or throw (the subprocess failed);
// subcommands it does not handle answer "{}". displays (optional) are the
// Electron displays; displays[displays.primaryIdx || 0] is Electron's primary.
// delays (optional, mutable) maps a subcommand to its reply delay in ms;
// reply.onCall(sub, args), when set, computes stdout at CALL time instead.
// The GNOME session daemon's runtime files, which the executor checks before a
// portal command to notice a daemon that `claude-desktop --reset-screen-sharing`
// ended or that crashed: socket present by default, no pidfile (pid null).
// Case [22] changes them. stopped = the stopped-by-user marker the daemon
// writes when the user clicks "Stop sharing" (case [25]).
// clock (optional, see makeClock) replaces the executor's setTimeout /
// clearTimeout, so the 120 s idle timer runs on a fake clock (cases [27]+).
const rigSocket = { present: true, pid: null, stopped: false };
// Electron's BrowserWindow.getAllWindows() for the dock check (case [55]).
const rigWindows = { list: [] };
function makeRig(consentMs, reply, displays, delays, clock) {
  const log = [], argv = [];
  const cp = {
    execFileSync(bin, args) {
      const base = path.basename(String(bin));
      if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
      log.push("SYNC " + base + " " + (args || []).join(" "));
      throw new Error("sync not expected");
    },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      const base = path.basename(String(bin));
      const sub = (args || [])[0];
      log.push("CALL " + sub);
      argv.push((args || []).join(" "));
      const delay = sub === "session-start" ? consentMs : ((delays && delays[sub]) || 0);
      const early = reply && reply.onCall ? reply.onCall(sub, args) : undefined;
      setTimeout(() => {
        log.push("DONE " + sub);
        let out = "{}";
        if (early !== undefined) out = early;
        else if (reply) { try { out = reply(sub, args) ?? "{}"; } catch (e) { cb(e, "", String(e.message)); return; } }
        cb(null, out, "");
      }, delay);
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const electron = {
    screen: { getAllDisplays: () => displays || [], getPrimaryDisplay: () => (displays && displays[displays.primaryIdx || 0]) || ({ id: 1, bounds: {x:0,y:0,width:1,height:1}, workArea:{x:0,y:0,width:1,height:1}, scaleFactor:1, label:"e" }), getCursorScreenPoint: () => ({x:0,y:0}) },
    desktopCapturer: { getSources: async () => { log.push("CAPTURER"); return []; } },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {},
    BrowserWindow: { getAllWindows: () => rigWindows.list }
  };
  const requireStub = (id) => {
    if (id === "child_process") return cp;
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (id === "os") return os;
    if (id === "fs") return {
      readFileSync: (p) => String(p).endsWith("/gnome-portal-bridge/session.pid") ? String(rigSocket.pid) : Buffer.alloc(0),
      writeFileSync(){}, unlinkSync(){},
      existsSync: (p) => String(p).endsWith("/gnome-portal-bridge/session.sock") ? rigSocket.present
        : String(p).endsWith("/gnome-portal-bridge/session.pid") ? rigSocket.pid !== null
        : String(p).endsWith("/gnome-portal-bridge/stopped-by-user") ? rigSocket.stopped : false, renameSync(){}, accessSync(){ throw new Error("no"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }) };
    throw new Error("unexpected require " + id);
  };
  globalThis.__cdbDiag = (m) => log.push("DIAG " + String(m));
  globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge";
  globalThis.__cuKwinMode = false;
  process.env.XDG_CURRENT_DESKTOP = "ubuntu:GNOME";
  process.env.XDG_SESSION_TYPE = "wayland";
  process.env.WAYLAND_DISPLAY = "wayland-0";
  delete process.env.SWAYSOCK; delete process.env.HYPRLAND_INSTANCE_SIGNATURE; delete process.env.NIRI_SOCKET;
  delete process.env.GNOME_PORTAL_BRIDGE_BIN;
  const src = readFileSync(EXECUTOR, "utf8");
  new Function("require", "process", "setTimeout", "clearTimeout", src)(requireStub, process,
    clock ? clock.setTimeout : setTimeout, clock ? clock.clearTimeout : clearTimeout);
  const ex = globalThis.__linuxExecutor;
  log.length = 0;
  return { ex, log, argv, cp, restore(){ delete globalThis.__linuxExecutor; } };
}


const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra ? "  -> " + extra : "")); return; }
  fail++; console.error("  FAIL " + label + (extra ? "  -> " + extra : ""));
}
const calls = (log) => log.filter(l => l.startsWith("CALL") || l.startsWith("DONE"));

console.log("\n[1] a release arriving during a pending session-start waits for it");
{
  const rig = makeRig(120);
  rig.ex.__setLockHeld(true);
  await sleep(10);
  await rig.ex.__setLockHeld(false);
  await sleep(300);
  const seq = calls(rig.log);
  ok(seq.join("|") === "CALL session-start|DONE session-start|CALL session-end|DONE session-end",
     "session-end is issued only after the pending start resolved", seq.join(" "));
  ok(rig.log.some(l => l.includes("waiting for an in-flight session-start")),
     "and the wait is reported in the diagnostics log");
  rig.restore();
}

console.log("\n[2] a lock re-acquired mid-teardown does not open a second session");
{
  const rig = makeRig(120);
  rig.ex.__setLockHeld(true);
  await sleep(10);
  rig.ex.__setLockHeld(false);
  await sleep(10);
  rig.ex.__setLockHeld(true);
  await sleep(500);
  const seq = calls(rig.log);
  ok(seq.filter(l => l === "CALL session-start").length === 1 ||
     seq.indexOf("CALL session-end") < seq.lastIndexOf("CALL session-start"),
     "the second start is queued BEHIND the end, never concurrent with it", seq.join(" "));
  const firstEnd = seq.indexOf("CALL session-end");
  const startsBeforeEnd = seq.slice(0, firstEnd).filter(l => l === "CALL session-start").length;
  ok(startsBeforeEnd === 1, "exactly one session-start is in flight before the teardown",
     String(startsBeforeEnd));
  ok(seq[seq.length - 1] === "DONE session-start",
     "and the run ends with the session UP, matching the lock that is held", seq.join(" "));
  rig.restore();
}

console.log("\n[3] the double release collapses to a single teardown");
{
  const rig = makeRig(120);
  rig.ex.__setLockHeld(true);
  await sleep(10);
  rig.ex.__setLockHeld(false);
  rig.ex.__setLockHeld(false);
  await sleep(500);
  const seq = calls(rig.log);
  ok(seq.filter(l => l === "CALL session-end").length === 1,
     "release + releaseExclusive issue session-end once, not twice", seq.join(" "));
  ok(seq[seq.length - 1] === "DONE session-end",
     "and the session is left DOWN, matching the released lock", seq.join(" "));
  rig.restore();
}

console.log("\n[4] a release cancels a start that is only QUEUED behind a teardown");
{
  // end -> start (queued, nothing running yet) -> end. The queued continuation
  // must consult the intent flag, not start unconditionally. Getting this wrong
  // leaves the portal session UP with no lock held, i.e. a live
  // RemoteDesktop/ScreenCast grant while the user believes CU is idle.
  const rig = makeRig(120);
  rig.ex.__setLockHeld(true);
  await sleep(10);
  rig.ex.__setLockHeld(false);   // teardown begins, parks on the pending start
  await sleep(5);
  rig.ex.__setLockHeld(true);    // queued behind the teardown
  await sleep(5);
  rig.ex.__setLockHeld(false);   // released again before the queue drains
  await sleep(600);
  const seq = calls(rig.log);
  const starts = seq.filter(l => l === "CALL session-start").length;
  ok(starts === 1, "no session is started after the final release", seq.join(" "));
  ok(seq[seq.length - 1] === "DONE session-end",
     "the run ends with the session DOWN, matching the released lock", seq.join(" "));
  ok(rig.log.some(l => l.includes("queued session-start cancelled")),
     "and the cancellation is reported in the diagnostics log");
  rig.restore();
}

console.log("\n[5] the ORDINARY lifecycle: start completes, then the lock is released");
{
  // The most common ordering in production and the easiest to leave uncovered:
  // every other case here releases while the start is still pending, so
  // _gnomeSessionStarting is non-null and any skip guard keyed on it is bypassed.
  // Here the start has fully settled, so the teardown has to decide on the
  // session flag alone. Getting that wrong means the portal session and the
  // gnome-portal-bridge daemon survive every single lock release.
  const rig = makeRig(20);
  rig.ex.__setLockHeld(true);
  await sleep(200);                 // let session-start fully settle
  await rig.ex.__setLockHeld(false);
  await sleep(300);
  const seq = calls(rig.log);
  ok(seq.includes("CALL session-end"),
     "a release after a completed start still ends the session", seq.join(" "));
  ok(seq[seq.length - 1] === "DONE session-end",
     "and the run ends with the session DOWN", seq.join(" "));
  ok(rig.log.some(l => l.includes("session ended")),
     "and the teardown is reported in the diagnostics log");
  rig.restore();
}

console.log("\n[6] a release with nothing ever started does not spawn session-end");
{
  const rig = makeRig(20);
  await rig.ex.__setLockHeld(false);   // released without ever acquiring
  await sleep(200);
  const seq = calls(rig.log);
  ok(seq.length === 0, "no bridge subprocess is spawned at all", seq.join(" ") || "(none)");
  rig.restore();
}

console.log("\n[7] a failed `screens` enumeration is retried after the cooldown (#293)");
{
  // Before: one failed `screens` was cached as "no monitors" for the whole
  // process, so every later zoom went out in GLOBAL coordinates with no
  // --display - on a two-monitor GNOME layout that is the region-out-of-bounds
  // error from issue #293, repeated until the app restarts.
  let screensCalls = 0;
  const SCREENS = JSON.stringify([{ id: "eDP-1", name: "eDP-1", geometry: { x: 0, y: 240, width: 100, height: 100 }, scale: 1, is_primary: true, is_active: true }]);
  const rig = makeRig(5, (sub) => {
    if (sub === "screens") { screensCalls++; if (screensCalls === 1) throw new Error("Command failed: screens"); return SCREENS; }
    if (sub === "zoom") return JSON.stringify({ base64: "QUJD", width: 10, height: 10 });
    return "{}";
  });
  const realNow = Date.now;
  try {
    rig.ex.__setLockHeld(true);
    await sleep(50);
    const first = await rig.ex.zoom({ x: 10, y: 250, w: 10, h: 10 }, 1, null);
    ok(first && first.base64 === "QUJD", "the first zoom still captures (bridge zoom answered)");
    ok(screensCalls === 1, "screens was asked once and failed", String(screensCalls));
    const second = await rig.ex.zoom({ x: 10, y: 250, w: 10, h: 10 }, 1, null);
    ok(second && second.base64 === "QUJD" && screensCalls === 1,
       "inside the cooldown no second screens subprocess is spawned", String(screensCalls));
    Date.now = () => realNow() + 31000;          // jump past SCREENS_RETRY_MS
    const third = await rig.ex.zoom({ x: 10, y: 250, w: 10, h: 10 }, 1, null);
    ok(third && third.base64 === "QUJD" && screensCalls === 2,
       "after the cooldown screens is asked again", String(screensCalls));
    await rig.ex.zoom({ x: 10, y: 250, w: 10, h: 10 }, 1, null);
    ok(screensCalls === 2, "a successful list is cached for the rest of the process", String(screensCalls));
    ok(rig.log.some(l => l.includes("screens failed") && l.includes("retrying in 30s")),
       "and the retry is announced in the diagnostics log");
  } finally {
    Date.now = realNow;
    rig.restore();
  }
}

// ── Default display = the monitor shared in the portal dialog (#293) ──────────
// The screenshot handler (js/cu_handler_injection.js), staged the way sub-patch 6
// of fix_computer_use_linux.nim stages it, run against the real executor above.
const INJECTION = path.join(ROOT, "js", "cu_handler_injection.js");
function buildHandler() {
  let src = readFileSync(INJECTION, "utf8").trim();
  for (const [ph, v] of [["__SELF__", "__self"], ["__MAKE_DISPATCH__", "__dispatch"], ["__STATE__", "__state"],
                         ["__TOOL_NAME__", "__tool"], ["__INPUT__", "__input"], ["__SESSION__", "__session"]]) {
    src = src.split(ph).join(v);
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("process", "require", "__self", "__dispatch", "__state", "__tool", "__input", "__session", src);
  return (tool, input) => fn({ platform: "linux", env: process.env }, () => ({}), {}, null, {}, tool, input || {}, {});
}
const handler = buildHandler();
// Electron: built-in panel is the primary (index 0), external monitor right of it (index 1).
const EDISPLAYS = [
  { id: 1, label: "Built-in", size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  { id: 2, label: "External", size: { width: 2560, height: 1440 }, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 }
];
const scr = (name, x, w, h, primary, shared) => {
  const o = { id: name, name, geometry: { x, y: 0, width: w, height: h }, scale: 1, is_primary: primary, is_active: true };
  if (shared !== undefined) o.is_shared = shared;
  return o;
};
// screens answers WITHOUT is_shared until session-start has finished (no daemon
// yet), then with the given share flags - the bridge contract.
function shareRig(sharedFlags, displays) {
  let daemon = false, screensCalls = 0;
  const rig = makeRig(20, (sub) => {
    if (sub === "session-start") { daemon = true; return "{}"; }
    if (sub === "screens") {
      screensCalls++;
      return JSON.stringify([scr("eDP-1", 0, 1920, 1080, true, daemon ? sharedFlags[0] : undefined),
                             scr("HDMI-1", 1920, 2560, 1440, false, daemon ? sharedFlags[1] : undefined)]);
    }
    if (sub === "zoom") return JSON.stringify({ base64: "QUJD", width: 10, height: 10 });
    return "{}";
  }, displays || EDISPLAYS);
  globalThis.__cuPinnedDisplay = undefined; globalThis.__cuLastShot = null; globalThis.__cuActiveOrigin = undefined;
  rig.screensCalls = () => screensCalls;
  return rig;
}
const zoomArgs = (rig) => rig.argv.filter(a => a.startsWith("zoom "));

console.log("\n[8] no display selected: the monitor shared in the portal dialog is the default (#293)");
{
  const rig = shareRig([false, true]);
  // A zoom BEFORE the lock caches a list without is_shared (no daemon yet).
  await rig.ex.zoom({ x: 10, y: 10, w: 10, h: 10 }, 1, null);
  ok(rig.screensCalls() === 1, "a pre-session screens list is fetched and cached", String(rig.screensCalls()));
  rig.ex.__setLockHeld(true);
  await sleep(60);
  const r = await handler("screenshot", {});
  ok(r && r.content && r.content.some((b) => b.type === "image"), "the screenshot returns an image", JSON.stringify(r).slice(0, 120));
  ok(rig.screensCalls() === 2, "session-start refreshed the cached screens list", String(rig.screensCalls()));
  const seq = calls(rig.log);
  ok(seq.lastIndexOf("CALL screens") > seq.indexOf("DONE session-start"),
     "screens is re-queried after the session daemon is up", seq.join(" "));
  const z = zoomArgs(rig);
  ok(/--display HDMI-1$/.test(z[z.length - 1] || ""), "the capture targets the shared monitor, not Electron's primary", z[z.length - 1]);
  ok(globalThis.__cuLastShot && globalThis.__cuLastShot.originX === 1920,
     "click coordinates map onto the shared monitor's origin", JSON.stringify(globalThis.__cuLastShot));
  ok(rig.log.some(l => l.includes("default display: shared monitor HDMI-1") && l.includes("Electron display 1")),
     "the choice is logged through __cdbDiag");
  await handler("screenshot", { display_number: 0 });
  const z0 = zoomArgs(rig);
  ok(/--display eDP-1$/.test(z0[z0.length - 1] || "") && globalThis.__cuLastShot.originX === 0,
     "an explicit display_number 0 beats the shared default", z0[z0.length - 1]);
  rig.restore();
}

console.log("\n[9] display_number 0 is a real selection, not \"unset\"");
{
  // Electron's primary is display 1 here, so `display_number||...||primary`
  // would have turned an explicit 0 into 1.
  const primaryExternal = [...EDISPLAYS]; primaryExternal.primaryIdx = 1;
  const rig = shareRig([undefined, undefined], primaryExternal);
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await handler("screenshot", { display_number: 0 });
  ok(globalThis.__cuLastShot.originX === 0, "display_number 0 captures display 0, not Electron's primary",
     JSON.stringify(globalThis.__cuLastShot));
  await handler("screenshot", {});
  ok(globalThis.__cuLastShot.originX === 1920, "with no display_number the primary (display 1) is used");
  rig.restore();
}

console.log("\n[10] no is_shared (bridge without the field) keeps Electron's primary");
{
  const rig = shareRig([undefined, undefined]);
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await handler("screenshot", {});
  const z = zoomArgs(rig);
  ok(/--display eDP-1$/.test(z[z.length - 1] || "") && globalThis.__cuLastShot.originX === 0,
     "falls back to Electron's primary", z[z.length - 1]);
  ok(!rig.log.some(l => l.includes("default display:")), "and logs no default-display choice");
  rig.restore();
}

console.log("\n[11] several shared: the Mutter primary among them wins");
{
  // Electron and Mutter disagree: Electron's primary is the external monitor.
  const swapped = [EDISPLAYS[1], EDISPLAYS[0]];
  const rig = shareRig([true, true], swapped);
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await handler("screenshot", {});
  ok(globalThis.__cuLastShot.originX === 0, "the shared Mutter primary (eDP-1) is used, not Electron's primary",
     JSON.stringify(globalThis.__cuLastShot));
  rig.restore();
}

console.log("\n[12] a shared monitor with no matching Electron display falls back, loudly");
{
  const rig = shareRig([false, true], [EDISPLAYS[0], { ...EDISPLAYS[1], bounds: { x: 3840, y: 0, width: 2560, height: 1440 } }]);
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await handler("screenshot", {});
  ok(globalThis.__cuLastShot.originX === 0, "Electron's primary is used");
  ok(rig.log.some(l => l.includes("[claude-cu] default display: shared monitor HDMI-1 at 1920,0 matches no Electron display")),
     "and the mismatch is logged through __cdbDiag");
  rig.restore();
}

const screensJson = (flags) => JSON.stringify([scr("eDP-1", 0, 1920, 1080, true, flags[0]), scr("HDMI-1", 1920, 2560, 1440, false, flags[1])]);
const ZOOM_OK = JSON.stringify({ base64: "QUJD", width: 10, height: 10 });
const resetShot = () => { globalThis.__cuPinnedDisplay = undefined; globalThis.__cuLastShot = null; globalThis.__cuActiveOrigin = undefined; };
const countCalls = (rig, sub) => rig.log.filter(l => l === "CALL " + sub).length;

console.log("\n[13] a stale in-flight screens reply landing after a session start is not cached");
{
  // The first fetch starts before session-start and still carries the share flags
  // of an earlier daemon; it resolves only after the new session invalidated the cache.
  let share = [true, false];
  const delays = { screens: 100 };
  const reply = (sub) => sub === "zoom" ? ZOOM_OK : "{}";
  reply.onCall = (sub) => {
    if (sub === "session-start") { share = [false, true]; return "{}"; }
    if (sub === "screens") return screensJson(share);
    return undefined;
  };
  const rig = makeRig(20, reply, EDISPLAYS, delays);
  resetShot();
  const z = rig.ex.zoom({ x: 10, y: 10, w: 10, h: 10 }, 1, null);   // screens in flight (100 ms)
  await sleep(10);
  rig.ex.__setLockHeld(true);                                      // session-start at ~30 ms
  await z; await sleep(50);
  delays.screens = 0;
  await handler("screenshot", {});
  ok(countCalls(rig, "screens") === 2, "the screenshot re-queries screens instead of using the stale reply", String(countCalls(rig, "screens")));
  ok(globalThis.__cuLastShot && globalThis.__cuLastShot.originX === 1920, "and targets the monitor shared in THIS session",
     JSON.stringify(globalThis.__cuLastShot));
  rig.restore();
}

console.log("\n[14] a list without is_shared during an active session is not cached");
{
  // The daemon missed the bridge's budget once: the first post-start list has no is_shared.
  let daemon = false, misses = 1;
  const rig = makeRig(20, (sub) => {
    if (sub === "session-start") { daemon = true; return "{}"; }
    if (sub === "screens") {
      if (daemon && misses > 0) { misses--; return screensJson([undefined, undefined]); }
      return screensJson(daemon ? [false, true] : [undefined, undefined]);
    }
    if (sub === "zoom") return ZOOM_OK;
    return "{}";
  }, EDISPLAYS);
  resetShot();
  const realNow = Date.now;
  try {
    rig.ex.__setLockHeld(true);
    await sleep(60);
    await handler("screenshot", {});
    ok(globalThis.__cuLastShot.originX === 0 && countCalls(rig, "screens") === 1,
       "the provisional list falls back to Electron's primary, one screens call", String(countCalls(rig, "screens")));
    ok(rig.log.some(l => l.includes("carries no is_shared during a portal session")), "and the miss is logged");
    Date.now = () => realNow() + 2500;            // past SCREENS_SHARE_RETRY_MS
    await handler("screenshot", {});
    ok(countCalls(rig, "screens") === 2 && globalThis.__cuLastShot.originX === 1920,
       "the next lookup re-queries and picks the shared monitor", String(countCalls(rig, "screens")));
    await handler("screenshot", {});
    ok(countCalls(rig, "screens") === 2, "the list with is_shared is cached", String(countCalls(rig, "screens")));
  } finally { Date.now = realNow; rig.restore(); }
}

console.log("\n[15] a screens failure in an earlier session does not block the next session");
{
  let daemon = false, screensCalls = 0;
  const rig = makeRig(20, (sub) => {
    if (sub === "session-start") { daemon = true; return "{}"; }
    if (sub === "session-end") { daemon = false; return "{}"; }
    if (sub === "screens") { screensCalls++; if (screensCalls === 1) throw new Error("Command failed: screens"); return screensJson(daemon ? [false, true] : [undefined, undefined]); }
    if (sub === "zoom") return ZOOM_OK;
    return "{}";
  }, EDISPLAYS);
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await handler("screenshot", {});
  ok(screensCalls === 1 && globalThis.__cuLastShot.originX === 0, "session 1: screens failed, primary used", String(screensCalls));
  await rig.ex.__setLockHeld(false);
  await sleep(60);
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await handler("screenshot", {});
  ok(screensCalls === 2 && globalThis.__cuLastShot.originX === 1920,
     "session 2 re-enumerates at once (no 30 s wait) and picks the shared monitor", String(screensCalls));
  rig.restore();
}

console.log("\n[16] a latched-down portal: the default-display lookup spawns no session-start");
{
  const rig = makeRig(20, (sub) => {
    if (sub === "session-start") throw new Error("portal refused");
    if (sub === "screens") return screensJson([undefined, undefined]);
    return "{}";
  }, EDISPLAYS);
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  ok(countCalls(rig, "session-start") === 1, "the lock's session-start ran once and failed");
  await handler("screenshot", {});
  ok(countCalls(rig, "session-start") === 1, "the screenshot did not retry session-start", String(countCalls(rig, "session-start")));
  rig.restore();
}

console.log("\n[17] COWORK_SCREENSHOT_CMD: a screenshot outside a lock does not open the portal");
{
  const rig = makeRig(20, (sub) => sub === "screens" ? screensJson([false, true]) : "{}", EDISPLAYS);
  rig.cp.execSync = () => "";                     // the user's capture command succeeds
  resetShot();
  process.env.COWORK_SCREENSHOT_CMD = "true {FILE}";
  try {
    const r = await handler("screenshot", {});
    ok(r && r.content && r.content.some((b) => b.type === "image"), "the screenshot is served by the command");
    ok(countCalls(rig, "session-start") === 0, "no session-start (no consent dialog)", rig.log.filter(l => l.startsWith("CALL")).join(" ") || "(none)");
  } finally { delete process.env.COWORK_SCREENSHOT_CMD; rig.restore(); }
}

console.log("\n[18] a session-start that FAILED while the lock is held is still ended on release");
{
  // The bridge's ready timeout leaves its daemon waiting on the consent dialog
  // by design; only a session-end removes it. Before: the release saw neither
  // an active session nor a start in flight and returned without one.
  const rig = makeRig(20, (sub) => { if (sub === "session-start") throw new Error("timed out waiting for the portal"); return "{}"; });
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await rig.ex.__setLockHeld(false);
  await sleep(40);
  ok(countCalls(rig, "session-end") === 1, "session-end is sent after the failed start", calls(rig.log).join(" "));
  await rig.ex.__setLockHeld(false);
  await sleep(40);
  ok(countCalls(rig, "session-end") === 1, "and only once: a successful end clears the daemon flag", String(countCalls(rig, "session-end")));
  rig.restore();
}
{
  const rig = makeRig(20);
  await rig.ex.__setLockHeld(false);
  await sleep(30);
  ok(countCalls(rig, "session-end") === 0, "a release with no start ever spawned still sends nothing");
  rig.restore();
}

console.log("\n[19] KWin twin (js/executor_linux.js): same failed-start release");
{
  // Load the ES module with its three imports swapped for stubs.
  const kw = [];
  // execFile is used through util.promisify, which resolves with the callback's
  // first value: hand it the {stdout, stderr} object the real one's custom
  // promisify returns.
  const cpStub = {
    execFile(bin, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; }
      const sub = (args || [])[0];
      kw.push(sub);
      setTimeout(() => sub === "session-start" ? cb(Object.assign(new Error("timed out waiting for the portal"), { stderr: "" }), "", "") : cb(null, { stdout: "{}", stderr: "" }), 5);
    },
    spawnSync() { return { status: 0 }; }
  };
  let src = readFileSync(path.join(ROOT, "js", "executor_linux.js"), "utf8")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  if (/^import /m.test(src)) { ok(false, "executor_linux.js imports changed - update this splice"); }
  else {
    const util = await import("node:util");
    const savedDebug = console.debug; console.debug = () => {};
    globalThis.__cdbDiag = () => {};
    globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
    try {
      const mod = new Function("__cp", "__util", src + "\nreturn { createLinuxExecutor };")(cpStub, util);
      const noop = new Proxy({}, { get: () => async () => null });
      const ex = mod.createLinuxExecutor({ backend: noop });
      try { await ex.__setLockHeld(true); } catch {}
      await sleep(20);
      await ex.__setLockHeld(false).catch(() => {});
      await sleep(20);
      ok(kw.filter(c => c === "session-end").length === 1, "session-end is sent after the failed start", kw.join(" "));
      await ex.__setLockHeld(false).catch(() => {});
      await sleep(20);
      ok(kw.filter(c => c === "session-end").length === 1, "and only once", kw.join(" "));
    } finally { console.debug = savedDebug; delete globalThis.__cuKwinBridgeBin; }
  }
}

// ── A monitor the user did not share: the error tells the model to ask the user ──
// The bridges stay generic (GNOME names its own `forget-session`); the executors
// rewrite the remedy into `claude-desktop --reset-screen-sharing`.
const RESET_HINT = "Ask the user to run `claude-desktop --reset-screen-sharing`, then share all monitors when the screen-sharing dialog appears.";
const GNOME_NOT_SHARED = "monitor HDMI-1 (1920,0 2560x1440) is not shared in the portal session (shared: eDP-1 at 0,0 1920x1080); " +
  "run `gnome-portal-bridge forget-session`, then start Computer Use again and select all monitors in the dialog";
const shotText = async (input) => {
  try { const r = await handler("screenshot", input); return (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r); }
  catch (e) { return "THREW " + e.message; }
};

console.log("\n[20] GNOME: a screenshot of an unshared monitor names the reset flag");
{
  const rig = makeRig(20, (sub) => {
    if (sub === "screens") return screensJson([true, false]);
    if (sub === "zoom") throw new Error("Command failed: /res/gnome-portal-bridge zoom --display HDMI-1\n" + GNOME_NOT_SHARED);
    return "{}";
  }, EDISPLAYS);
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  const text = await shotText({ display_number: 1 });
  ok(text.includes("Monitor HDMI-1 is not shared with Claude (shared: eDP-1 at 0,0 1920x1080). " + RESET_HINT),
     "the model reads the monitor, the shared list and the user instruction", text);
  ok(!text.includes("forget-session"), "the bridge-internal remedy is gone");
  ok(!text.includes("every capture tier failed"), "the cause is not buried under a capture-tier fallback");
  rig.restore();
}

console.log("\n[21] GNOME: not-shared text that does not parse keeps its wording, the instruction is appended");
{
  const odd = "monitor HDMI-1 is not shared in the portal session; run `gnome-portal-bridge forget-session`";
  const rig = makeRig(20, (sub) => {
    if (sub === "screens") return screensJson([true, false]);
    if (sub === "zoom") throw new Error("Command failed: zoom\n" + odd);
    return "{}";
  }, EDISPLAYS);
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  const text = await shotText({ display_number: 1 });
  ok(text.includes(odd + ". " + RESET_HINT), "original text + the instruction", text);
  rig.restore();
}
{
  // An unrelated bridge failure is left alone.
  const rig = makeRig(20, (sub) => {
    if (sub === "screens") return screensJson([true, false]);
    if (sub === "zoom") throw new Error("Command failed: zoom\nPipeWire stream stalled");
    return "{}";
  }, EDISPLAYS);
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  const text = await shotText({ display_number: 1 });
  ok(!text.includes("reset-screen-sharing"), "an unrelated failure gets no reset instruction", text);
  rig.restore();
}

console.log("\n[22] GNOME: a session daemon ended by --reset-screen-sharing is replaced by ONE new session");
{
  const rig = shareRig([true, true]);
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await handler("screenshot", {});
  ok(countCalls(rig, "session-start") === 1, "one session-start for the lock");
  await handler("screenshot", {});
  ok(countCalls(rig, "session-start") === 1, "a live daemon (socket present) is reused", String(countCalls(rig, "session-start")));
  rigSocket.present = false;                       // forget-session ended the daemon
  try {
    const r = await handler("screenshot", {});
    ok(r && r.content && r.content.some((b) => b.type === "image"), "the next screenshot still captures");
    ok(countCalls(rig, "session-start") === 2, "after a fresh session-start", String(countCalls(rig, "session-start")));
    ok(rig.log.some(l => l.includes("session daemon is gone")), "and the restart is logged");
  } finally { rigSocket.present = true; rig.restore(); }
}

console.log("\n[22b] GNOME, sync input after a reset: no blocking session-start, one background start");
{
  // The grant is gone, so session-start means a consent dialog: the sync
  // backstop (8 s, main process blocked) must not run it.
  const rig = shareRig([true, true]);
  const sync = [];
  rig.cp.execFileSync = (bin, args) => {
    const base = path.basename(String(bin));
    if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
    sync.push((args || [])[0]);
    return "{}";
  };
  rig.ex.__setLockHeld(true);
  await sleep(60);
  await rig.ex.moveMouse(5, 5);
  ok(sync.join(" ") === "pointer-move", "a live session: the move goes straight to the bridge", sync.join(" "));
  rigSocket.present = false;                       // forget-session ended the daemon
  try {
    let err = null;
    try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
    ok(err && /The screen-sharing session was reset .*Ask the user to approve the screen-sharing dialog, then retry the action\./.test(err.message),
       "the model is told the user must approve the dialog", err && err.message);
    ok(!sync.includes("session-start"), "no blocking session-start on the main process", sync.join(" "));
    ok(sync.filter(c => c === "pointer-move").length === 1, "the move itself is not sent", sync.join(" "));
    ok(countCalls(rig, "session-start") === 2, "one background session-start (full consent budget)", String(countCalls(rig, "session-start")));
    rigSocket.present = true;
    await sleep(60);
    await rig.ex.moveMouse(5, 5);
    ok(sync.filter(c => c === "pointer-move").length === 2 && countCalls(rig, "session-start") === 2,
       "once approved, the retry runs on the new session", sync.join(" "));
  } finally { rigSocket.present = true; rig.restore(); }
}

console.log("\n[22c] GNOME: a crashed daemon (socket left behind, pid dead) is noticed; a live pid is not");
{
  const rig = shareRig([true, true]);
  rig.ex.__setLockHeld(true);
  await sleep(60);
  try {
    rigSocket.pid = process.pid;                   // alive
    await handler("screenshot", {});
    ok(countCalls(rig, "session-start") === 1, "live pid: the session is reused", String(countCalls(rig, "session-start")));
    rigSocket.pid = 0x3fffffff;                    // no such process (ESRCH)
    await handler("screenshot", {});
    ok(countCalls(rig, "session-start") === 2, "dead pid: a new session is started", String(countCalls(rig, "session-start")));
  } finally { rigSocket.pid = null; rig.restore(); }
}

console.log("\n[22d] GNOME, contract exit codes: 4 recovers the session, 3 is rewritten without the old tail");
{
  const rig = shareRig([true, true]);
  const sync = [];
  rig.cp.execFileSync = (bin, args) => {
    const base = path.basename(String(bin));
    if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
    const sub = (args || [])[0];
    sync.push(sub);
    if (sub === "pointer-move" && sync.filter(c => c === "pointer-move").length === 1)
      throw Object.assign(new Error("Command failed: pointer-move\nno live portal session"), { status: 4 });
    if (sub === "pointer-move")
      throw Object.assign(new Error("Command failed: pointer-move\nmonitor HDMI-1 (1920,0 2560x1440) is not shared in the portal session (shared: eDP-1 at 0,0 1920x1080)"), { status: 3 });
    return "{}";
  };
  rig.ex.__setLockHeld(true);
  await sleep(60);
  let err = null;
  try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
  ok(err && /The screen-sharing session was reset/.test(err.message), "exit 4: the reset message", err && err.message);
  ok(countCalls(rig, "session-start") === 2 && !sync.includes("session-start"),
     "exit 4: one background session-start, none blocking", String(countCalls(rig, "session-start")));
  await sleep(60);
  err = null;
  try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
  ok(err && err.message.includes("Monitor HDMI-1 is not shared with Claude (shared: eDP-1 at 0,0 1920x1080). " + RESET_HINT),
     "exit 3 with the contract text (no bridge remedy): rewritten", err && err.message);
  rig.restore();
}
{
  const rig = makeRig(20, (sub) => {
    if (sub === "screens") return screensJson([true, false]);
    if (sub === "zoom") throw Object.assign(new Error("Command failed: zoom\nthe display is not in this session"), { code: 3 });
    return "{}";
  }, EDISPLAYS);
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  const text = await shotText({ display_number: 1 });
  ok(text.includes("the display is not in this session. " + RESET_HINT), "exit 3 with text that does not parse: instruction appended", text);
  rig.restore();
}

console.log("\n[22e] GNOME: session-start answering \"already active\" is that session, not a failure");
{
  let screensCalls = 0;
  const rig = makeRig(20, (sub) => {
    if (sub === "session-start") throw new Error("Command failed: session-start\na portal session is already active");
    if (sub === "screens") { screensCalls++; return screensJson([true, true]); }
    if (sub === "zoom") return ZOOM_OK;
    return "{}";
  }, EDISPLAYS);
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  const r = await handler("screenshot", {});
  ok(r && r.content && r.content.some((b) => b.type === "image"), "the screenshot captures on the existing session", JSON.stringify(r).slice(0, 120));
  ok(countCalls(rig, "session-start") === 1, "no second start", String(countCalls(rig, "session-start")));
  ok(!rig.log.some(l => l.includes("session-start failed")), "no failure logged, no portal-down latch");
  rig.restore();
}

console.log("\n[22f] GNOME: an undeterminable runtime dir never concludes \"daemon gone\"; exit 4 still recovers");
{
  // Set-but-empty XDG_RUNTIME_DIR: contract bridges read /tmp, older ones a
  // relative path; a relative value is unusable. Concluding "no socket" there
  // would restart the session before every command against an older bridge.
  const saved = process.env.XDG_RUNTIME_DIR;
  for (const [label, value] of [["empty", ""], ["relative", "run/user"]]) {
    let fail4 = false;
    const rig = makeRig(20, (sub) => {
      if (sub === "screens") return screensJson([true, true]);
      if (sub === "zoom") {
        if (fail4) { fail4 = false; throw Object.assign(new Error("Command failed: zoom\nno active portal session"), { code: 4 }); }
        return ZOOM_OK;
      }
      return "{}";
    }, EDISPLAYS);
    resetShot();
    rig.ex.__setLockHeld(true);
    await sleep(60);
    process.env.XDG_RUNTIME_DIR = value;
    rigSocket.present = false;
    try {
      await handler("screenshot", {});
      await handler("screenshot", {});
      ok(countCalls(rig, "session-start") === 1, `${label} XDG_RUNTIME_DIR: no restart from a missing socket`, String(countCalls(rig, "session-start")));
      fail4 = true;
      const text = await shotText({});
      ok(/The screen-sharing session was reset/.test(text) && countCalls(rig, "session-start") === 2,
         `${label} XDG_RUNTIME_DIR: exit 4 still starts one new session`, text);
    } finally {
      rigSocket.present = true;
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved;
      rig.restore();
    }
  }
}

// ── The user stopped screen sharing (bridge exit 5) ──────────────────────────
// The desktop's screen-sharing indicator has a "Stop sharing" button. The
// bridge daemon then writes its stopped-by-user marker, exits, and every
// input/capture command exits 5. Within the lock nothing may start a new
// session (that would re-share the screen the user just stopped sharing); the
// next lock starts clean.
const STOPPED_MSG = "Screen sharing was stopped from the desktop (its screen-sharing indicator, or the desktop ended the session). Stop using Computer Use and ask the user whether to continue; do not retry. Computer Use can share the screen again once the task ends or after about 2 minutes without Computer Use actions.";
// Bridge stderr: the old wording, and the current one (text fallback for both).
const STOPPED_STDERR = "screen sharing was stopped by the user (the portal session was closed)";
const STOPPED_STDERR_NEW = "screen sharing was stopped (the portal session was closed)";
// A rig whose portal commands exit 5 while stop.on is set (async + sync paths).
function stoppedRig() {
  const stop = { on: false, code: 5, text: STOPPED_STDERR };
  const rig = makeRig(20, (sub) => {
    if (sub === "screens") return screensJson([true, true]);
    if (sub === "zoom") {
      if (stop.on) throw Object.assign(new Error("Command failed: zoom\n" + stop.text), { code: stop.code });
      return ZOOM_OK;
    }
    return "{}";
  }, EDISPLAYS);
  rig.sync = [];
  rig.cp.execFileSync = (bin, args) => {
    const base = path.basename(String(bin));
    if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
    const sub = (args || [])[0];
    rig.sync.push(sub);
    if (stop.on && sub !== "session-start" && sub !== "session-end")
      throw Object.assign(new Error("Command failed: " + sub + "\n" + stop.text), { status: stop.code });
    return "{}";
  };
  rig.stop = stop;
  resetShot();
  return rig;
}

console.log("\n[24] GNOME: exit 5 -> the model is told to stop; no new session within the lock");
{
  const rig = stoppedRig();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  let r = await handler("screenshot", {});
  ok(r && r.content && r.content.some((b) => b.type === "image"), "a live session captures");
  rig.stop.on = true;                              // the user clicked "Stop sharing"
  const capBefore = rig.log.filter(l => l === "CAPTURER").length;
  let text = await shotText({});
  ok(text.includes(STOPPED_MSG), "screenshot exit 5: the model reads the stop message", text);
  ok(rig.log.filter(l => l === "CAPTURER").length === capBefore && !text.includes("every capture tier failed"),
     "and the capture does not fall through to desktopCapturer", text);
  ok(rig.log.some(l => l.includes("screen sharing was stopped (bridge exit 5)")), "the stop is logged");
  const zooms = countCalls(rig, "zoom");
  text = await shotText({});
  ok(text.includes(STOPPED_MSG), "the next screenshot gets the same message", text);
  ok(countCalls(rig, "zoom") === zooms, "fail fast: no bridge spawned for it", String(countCalls(rig, "zoom")));
  let err = null;
  try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
  ok(err && err.message === STOPPED_MSG, "sync input: same message", err && err.message);
  ok(rig.sync.length === 0, "sync input: no bridge spawned, no blocking session-start", rig.sync.join(" "));
  rigSocket.present = false;                       // the daemon removed its socket on the way out
  try {
    text = await shotText({});
    err = null;
    try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
    ok(text.includes(STOPPED_MSG) && err && err.message === STOPPED_MSG, "a missing socket changes nothing after the stop", text);
    ok(countCalls(rig, "session-start") === 1, "no session-start within the lock (no vanished-daemon / exit-4 recovery)",
       String(countCalls(rig, "session-start")));
    ok(!rig.log.some(l => l.includes("session daemon is gone")), "the stop is not mistaken for a vanished daemon");
    await rig.ex.__setLockHeld(false);
    await sleep(40);
    ok(countCalls(rig, "session-end") === 1, "the release still sends session-end (it clears the marker)",
       String(countCalls(rig, "session-end")));
    ok(rig.log.some(l => l.includes("stopped-by-user latch cleared (lock released)")), "and the latch is cleared");
    rig.stop.on = false;
    rigSocket.present = true;
    rig.ex.__setLockHeld(true);                    // the next task
    await sleep(60);
    ok(countCalls(rig, "session-start") === 2, "the next lock starts a session", String(countCalls(rig, "session-start")));
    resetShot();
    r = await handler("screenshot", {});
    ok(r && r.content && r.content.some((b) => b.type === "image"), "and captures on it");
    await rig.ex.moveMouse(5, 5);
    ok(rig.sync.join(" ") === "pointer-move", "sync input runs again", rig.sync.join(" "));
  } finally { rigSocket.present = true; rig.restore(); }
}
for (const text of [STOPPED_STDERR, STOPPED_STDERR_NEW]) {
  // A bridge below contract 1 says it in text only (old and new wording).
  const rig = stoppedRig();
  rig.stop.code = 1; rig.stop.text = text;
  rig.ex.__setLockHeld(true);
  await sleep(60);
  rig.stop.on = true;
  let err = null;
  try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
  ok(err && err.message === STOPPED_MSG, `exit 1 + "${text}": same message`, err && err.message);
  err = null;
  try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
  ok(err && err.message === STOPPED_MSG && rig.sync.filter(c => c === "pointer-move").length === 1,
     "and the latch holds (one pointer-move spawned)", rig.sync.join(" "));
  ok(countCalls(rig, "session-start") === 1, "no session-start", String(countCalls(rig, "session-start")));
  rig.restore();
}

console.log("\n[25] GNOME: the stopped-by-user marker is a stop, not a vanished daemon");
{
  const rig = stoppedRig();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  rigSocket.present = false; rigSocket.stopped = true;   // daemon wrote the marker, removed its socket, exited
  try {
    const zooms = countCalls(rig, "zoom");
    const text = await shotText({});
    ok(text.includes(STOPPED_MSG), "screenshot: the stop message", text);
    ok(countCalls(rig, "zoom") === zooms && countCalls(rig, "session-start") === 1,
       "no zoom spawned, no session-start", `zoom ${countCalls(rig, "zoom")} start ${countCalls(rig, "session-start")}`);
    ok(!rig.log.some(l => l.includes("session daemon is gone")), "never \"daemon gone\"");
    ok(rig.log.filter(l => l === "CAPTURER").length === 0, "no desktopCapturer fallback");
    let err = null;
    try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
    ok(err && err.message === STOPPED_MSG && rig.sync.length === 0, "sync input: the stop message, nothing spawned", rig.sync.join(" "));
    await sleep(60);
    ok(countCalls(rig, "session-start") === 1, "still no background session-start", String(countCalls(rig, "session-start")));
    await rig.ex.__setLockHeld(false);
    await sleep(40);
    ok(countCalls(rig, "session-end") === 1, "release: session-end", String(countCalls(rig, "session-end")));
    rigSocket.present = true; rigSocket.stopped = false;  // session-end removed the marker
    rig.ex.__setLockHeld(true);
    await sleep(60);
    ok(countCalls(rig, "session-start") === 2, "next lock: a session-start", String(countCalls(rig, "session-start")));
  } finally { rigSocket.present = true; rigSocket.stopped = false; rig.restore(); }
}
{
  // A marker left from an earlier lock (its session-end failed) does not block
  // the next lock: the latch is per lock and session-start removes the marker.
  rigSocket.stopped = true;
  const rig = stoppedRig();
  try {
    rig.ex.__setLockHeld(true);
    await sleep(10);
    rigSocket.stopped = false;                     // session-start removed it
    await sleep(60);
    const r = await handler("screenshot", {});
    ok(r && r.content && r.content.some((b) => b.type === "image") && countCalls(rig, "session-start") === 1,
       "a stale marker before session-start: the lock still works", JSON.stringify(r).slice(0, 120));
  } finally { rigSocket.stopped = false; rig.restore(); }
}

console.log("\n[25b] GNOME: session-start exit 5 (closed before ready) latches; no cooldown, no retry");
{
  // The bridge answers session-start with exit 5 when the new daemon's portal
  // session is closed before it becomes ready.
  let startStopped = true;
  const rig = makeRig(20, (sub) => {
    if (sub === "session-start" && startStopped) throw Object.assign(new Error("Command failed: session-start\n" + STOPPED_STDERR_NEW), { code: 5 });
    if (sub === "screens") return screensJson([true, true]);
    if (sub === "zoom") return ZOOM_OK;
    return "{}";
  }, EDISPLAYS);
  const sync = [];
  rig.cp.execFileSync = (bin, args) => {
    const base = path.basename(String(bin));
    if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
    sync.push((args || [])[0]);
    return "{}";
  };
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(60);
  const text = await shotText({});
  ok(text.includes(STOPPED_MSG), "screenshot: the stop message", text);
  ok(countCalls(rig, "session-start") === 1 && countCalls(rig, "zoom") === 0, "no second start, no zoom",
     `start ${countCalls(rig, "session-start")} zoom ${countCalls(rig, "zoom")}`);
  ok(!rig.log.some(l => l.includes("portal session unavailable")), "a stop, not the failure cooldown");
  ok(rig.log.filter(l => l === "CAPTURER").length === 0, "no desktopCapturer fallback");
  let err = null;
  try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
  ok(err && err.message === STOPPED_MSG && sync.length === 0, "sync input: the stop message, no blocking session-start", sync.join(" "));
  await rig.ex.__setLockHeld(false);
  await sleep(40);
  ok(countCalls(rig, "session-end") === 1, "release: session-end", String(countCalls(rig, "session-end")));
  startStopped = false;
  rig.ex.__setLockHeld(true);
  await sleep(60);
  const r = await handler("screenshot", {});
  ok(countCalls(rig, "session-start") === 2 && r && r.content && r.content.some((b) => b.type === "image"),
     "next lock: a new session, and it captures", String(countCalls(rig, "session-start")));
  rig.restore();
}
{
  // No lock hook: the sync backstop's session-start exits 5.
  const rig = makeRig(20, () => "{}", EDISPLAYS);
  const sync = [];
  rig.cp.execFileSync = (bin, args) => {
    const base = path.basename(String(bin));
    if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
    const sub = (args || [])[0];
    sync.push(sub);
    if (sub === "session-start") throw Object.assign(new Error("Command failed: session-start\n" + STOPPED_STDERR_NEW), { status: 5 });
    return "{}";
  };
  let err = null;
  try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
  ok(err && err.message === STOPPED_MSG && sync.join(" ") === "session-start", "sync backstop exit 5: the stop message, the move is not sent", sync.join(" "));
  err = null;
  try { await rig.ex.moveMouse(5, 5); } catch (e) { err = e; }
  ok(err && err.message === STOPPED_MSG && sync.join(" ") === "session-start", "and no second blocking session-start", sync.join(" "));
  await rig.ex.__setLockHeld(false);
  await sleep(40);
  ok(countCalls(rig, "session-end") === 1, "a release sends session-end", String(countCalls(rig, "session-end")));
  rig.restore();
}

console.log("\n[23] KWin (js/executor_linux.js): not-shared rewrite and a vanished daemon");
{
  const kw = [];
  let failWith = null;                             // stderr for the next portal command
  let failCode = 1;                                // its exit code
  const cpStub = {
    execFile(bin, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; }
      const sub = (args || [])[0];
      kw.push(sub);
      setTimeout(() => {
        if (failWith && sub !== "session-start" && sub !== "session-end") {
          const stderr = failWith, code = failCode; failWith = null; failCode = 1;
          cb(Object.assign(new Error("Command failed"), { stderr, code }), "", "");
          return;
        }
        cb(null, { stdout: "{}", stderr: "" });
      }, 2);
    },
    spawnSync() { return { status: 0 }; }
  };
  let src = readFileSync(path.join(ROOT, "js", "executor_linux.js"), "utf8")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  if (/^import /m.test(src)) { ok(false, "executor_linux.js imports changed - update this splice"); }
  else {
    const util = await import("node:util");
    const savedDebug = console.debug; console.debug = () => {};
    const diag = [];
    globalThis.__cdbDiag = (m) => diag.push(String(m));
    globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
    try {
      const mod = new Function("__cp", "__util", src +
        "\nreturn { notSharedText, startBridgeSession, stopBridgeSession, createRustLinuxBackend };")(cpStub, util);
      const rust = mod.createRustLinuxBackend();
      await mod.startBridgeSession();
      const fails = async (f) => { try { await f(); return "no error"; } catch (e) { return e.message; } };

      failWith = "Error: no portal stream matched screen `DP-2`";
      let msg = await fails(() => rust.mouseDown());
      ok(msg === "[kwin-portal-bridge] left-mouse-down failed: Error: Monitor DP-2 is not shared with Claude. " + RESET_HINT,
         "KDE wording -> monitor id + user instruction", msg);
      ok(mod.notSharedText(GNOME_NOT_SHARED) === "Monitor HDMI-1 is not shared with Claude (shared: eDP-1 at 0,0 1920x1080). " + RESET_HINT,
         "GNOME wording is understood too");
      ok(mod.notSharedText("no portal stream matched the screen") === "no portal stream matched the screen. " + RESET_HINT,
         "unparseable not-shared text: original + instruction");
      ok(mod.notSharedText("KWin script timed out") === null, "unrelated text is left alone");

      failCode = 3;
      failWith = "monitor DP-2 (2560,0 1920x1080) is not shared in the portal session (shared: DP-1 at 0,0 2560x1440)";
      msg = await fails(() => rust.mouseDown());
      ok(msg === "[kwin-portal-bridge] left-mouse-down failed: Monitor DP-2 is not shared with Claude (shared: DP-1 at 0,0 2560x1440). " + RESET_HINT,
         "exit 3, contract text -> rewritten with the shared list", msg);
      failCode = 3; failWith = "screen is not part of the share";
      msg = await fails(() => rust.mouseDown());
      ok(msg.endsWith("screen is not part of the share. " + RESET_HINT), "exit 3, unparseable text -> instruction appended", msg);

      const starts = () => kw.filter(c => c === "session-start").length;
      ok(starts() === 1, "one session-start so far", kw.join(" "));
      failWith = "no active portal session";       // forget-session ended the daemon (older bridge text)
      msg = await fails(() => rust.mouseDown());
      ok(/the screen-sharing session was ended; retry the action/.test(msg), "the model is told to retry", msg);
      ok(starts() === 1, "the failed command is not retried behind the model's back", kw.join(" "));
      msg = await fails(() => rust.mouseDown());
      ok(msg === "no error" && starts() === 2, "the next command starts one fresh session", kw.join(" "));
      failCode = 4; failWith = "session daemon not running";   // contract 1: exit code, any text
      msg = await fails(() => rust.mouseDown());
      ok(/the screen-sharing session was ended; retry the action/.test(msg), "exit 4 -> same recovery", msg);
      msg = await fails(() => rust.mouseDown());
      ok(msg === "no error" && starts() === 3, "and again one fresh session", kw.join(" "));
      ok(diag.some(l => l.includes("session daemon is gone")), "and the restart is logged");
      await mod.stopBridgeSession();
    } finally { console.debug = savedDebug; delete globalThis.__cuKwinBridgeBin; }
  }
}

console.log("\n[26] KWin (js/executor_linux.js): exit 5 latches for the lock; the next lock starts clean");
{
  const kw = [];
  let stopped = false, stopCode = 5, stopText = STOPPED_STDERR, startStopped = false;
  const cpStub = {
    execFile(bin, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; }
      const sub = (args || [])[0];
      kw.push(sub);
      setTimeout(() => {
        if (sub === "session-start" && startStopped) {
          cb(Object.assign(new Error("Command failed"), { stderr: STOPPED_STDERR_NEW, code: 5 }), "", "");
          return;
        }
        if (stopped && sub !== "session-start" && sub !== "session-end") {
          cb(Object.assign(new Error("Command failed"), { stderr: stopText, code: stopCode }), "", "");
          return;
        }
        if (sub === "session-end") stopped = false;    // session-end removes the marker
        cb(null, { stdout: "{}", stderr: "" });
      }, 2);
    },
    spawnSync() { return { status: 0 }; }
  };
  let src = readFileSync(path.join(ROOT, "js", "executor_linux.js"), "utf8")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  if (/^import /m.test(src)) { ok(false, "executor_linux.js imports changed - update this splice"); }
  else {
    const util = await import("node:util");
    const savedDebug = console.debug; console.debug = () => {};
    const diag = [];
    globalThis.__cdbDiag = (m) => diag.push(String(m));
    globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
    try {
      const mod = new Function("__cp", "__util", src +
        "\nreturn { STOPPED_BY_USER_MESSAGE, startBridgeSession, stopBridgeSession, createRustLinuxBackend };")(cpStub, util);
      ok(mod.STOPPED_BY_USER_MESSAGE === STOPPED_MSG, "the KWin message is the GNOME twin's");
      const rust = mod.createRustLinuxBackend();
      const fails = async (f) => { try { await f(); return "no error"; } catch (e) { return e.message; } };
      const count = (c) => kw.filter(x => x === c).length;
      for (const [label, code, text] of [["exit 5", 5, STOPPED_STDERR], ["exit 1 + old text", 1, STOPPED_STDERR], ["exit 1 + new text", 1, STOPPED_STDERR_NEW]]) {
        stopCode = code; stopText = text;
        await mod.startBridgeSession();
        const starts0 = count("session-start"), ends0 = count("session-end");
        ok((await fails(() => rust.mouseDown())) === "no error", `${label}: a live session works`);
        stopped = true;                              // the user clicked "Stop sharing"
        let msg = await fails(() => rust.mouseDown());
        ok(msg === STOPPED_MSG, `${label}: the model reads the stop message`, msg);
        const downs = count("left-mouse-down");
        msg = await fails(() => rust.mouseDown());
        ok(msg === STOPPED_MSG && count("left-mouse-down") === downs, `${label}: fail fast, no bridge spawned`, kw.join(" "));
        msg = await fails(() => rust.screenshot(0));
        ok(msg === STOPPED_MSG && count("screenshot") === 0, `${label}: screenshot gets the message, no capture`, msg);
        ok(count("session-start") === starts0, `${label}: no session-start within the lock (exit-4 recovery stays off)`, kw.join(" "));
        await mod.stopBridgeSession();
        ok(count("session-end") === ends0 + 1, `${label}: the release still sends session-end`, kw.join(" "));
        await mod.startBridgeSession();
        ok(count("session-start") === starts0 + 1, `${label}: the next lock starts a session`, kw.join(" "));
        msg = await fails(() => rust.mouseDown());
        ok(msg === "no error", `${label}: and input works again`, msg);
        await mod.stopBridgeSession();
      }
      ok(diag.some(l => l.includes("screen sharing was stopped (left-mouse-down)")) && diag.some(l => l.includes("stopped-by-user latch cleared")),
         "the stop and the clear are logged");
      // session-start exit 5: the new daemon was closed before it became ready.
      startStopped = true;
      const s0 = count("session-start"), e0 = count("session-end"), d0 = count("left-mouse-down");
      let msg = await fails(() => mod.startBridgeSession());
      ok(msg === STOPPED_MSG, "session-start exit 5: the lock start reports the stop", msg);
      startStopped = false;
      msg = await fails(() => rust.mouseDown());
      ok(msg === STOPPED_MSG && count("session-start") === s0 + 1 && count("left-mouse-down") === d0,
         "session-start exit 5: later actions fail fast, no second start", kw.join(" "));
      await mod.stopBridgeSession();
      ok(count("session-end") === e0 + 1, "session-start exit 5: the release still sends session-end", kw.join(" "));
      await mod.startBridgeSession();
      msg = await fails(() => rust.mouseDown());
      ok(msg === "no error" && count("session-start") === s0 + 2, "session-start exit 5: the next lock starts clean", kw.join(" "));
      await mod.stopBridgeSession();
    } finally { console.debug = savedDebug; delete globalThis.__cuKwinBridgeBin; }
  }
}

// ── Idle teardown and the task boundary (issue #293 follow-up) ───────────────
// Upstream can hold the CU lock for many turns (cloud Cowork releases it only
// after a 12 min idle sweep), so the lock alone left the portal session - and
// the desktop's "screen is being shared" indicator - up after the task, and a
// stop-sharing latch blocking the next task. The executor now ends the session
// CU_PORTAL_IDLE_MS (120 s) after the last real portal command, lifts the latch
// after the same idle time, and ends both on __cuTaskBoundary (upstream's
// releaseRemoteCuLock renderer IPC). The idle timer runs on a fake clock.
const IDLE_MS = 120000;
// Fake setTimeout/clearTimeout for the executor: delays of 60 s and more are
// held on a virtual clock that only advance() moves; shorter ones (the bridge
// stubs, spawn probes) stay real.
function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  const clock = {
    // hold(): any delay on the virtual clock (the session check's 10 s timers).
    hold(fn, ms, ...a) { return clock.setTimeout(fn, ms, ...a, { __hold: true }); },
    now() { return now; },
    setTimeout(fn, ms, ...a) {
      const held = a.length && a[a.length - 1] && a[a.length - 1].__hold;
      if (held) a = a.slice(0, -1);
      if (!held && !(ms >= 60000)) return setTimeout(fn, ms, ...a);
      const t = { __fake: true, id: ++seq, ms, due: now + ms, fn, a, unrefd: false,
                  unref() { this.unrefd = true; return this; }, ref() { this.unrefd = false; return this; }, hasRef() { return !this.unrefd; } };
      timers.set(t.id, t);
      return t;
    },
    clearTimeout(t) { if (t && t.__fake) { timers.delete(t.id); return; } clearTimeout(t); },
    pending() { return [...timers.values()]; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const t of timers.values()) if (t.due <= end && (!next || t.due < next.due)) next = t;
        if (!next) break;
        now = next.due; timers.delete(next.id); next.fn(...next.a);
      }
      now = end;
    }
  };
  return clock;
}
const PORTAL_SUBS = new Set(["zoom", "screenshot", "pointer-move", "pointer-click", "pointer-scroll", "pointer-drag",
                             "left-mouse-down", "left-mouse-up", "key-sequence", "type", "hold-key"]);
// Async replies as in the share rigs; sync (input) calls succeed unless stop.on,
// which makes every portal command exit 5 on both paths (the user clicked
// "Stop sharing"). rig.onSync(sub), when set, runs inside a sync bridge call.
function idleRig(delays) {
  const clock = makeClock();
  const stop = { on: false, start: false };       // start: session-start itself exits 5
  const rig = makeRig(20, (sub) => {
    if (sub === "session-start" && stop.start) throw Object.assign(new Error("Command failed: session-start\n" + STOPPED_STDERR_NEW), { code: 5 });
    if (sub === "screens") return screensJson([true, true]);
    if (PORTAL_SUBS.has(sub) && stop.on) throw Object.assign(new Error("Command failed: " + sub + "\n" + STOPPED_STDERR), { code: 5 });
    if (sub === "zoom") return ZOOM_OK;
    return "{}";
  }, EDISPLAYS, delays, clock);
  rig.sync = [];
  rig.cp.execFileSync = (bin, args) => {
    const base = path.basename(String(bin));
    if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
    const sub = (args || [])[0];
    rig.sync.push(sub);
    if (rig.onSync) rig.onSync(sub);
    if (sub === "session-start" && stop.start) throw Object.assign(new Error("Command failed: session-start\n" + STOPPED_STDERR_NEW), { status: 5 });
    if (stop.on && PORTAL_SUBS.has(sub)) throw Object.assign(new Error("Command failed: " + sub + "\n" + STOPPED_STDERR), { status: 5 });
    return "{}";
  };
  rig.clock = clock;
  rig.stop = stop;
  rig.zoom = () => rig.ex.zoom({ x: 10, y: 10, w: 10, h: 10 }, 1, null);
  rig.idleLogged = () => rig.log.some(l => l.includes("idle for 120 s, ending the portal session"));
  rig.deferred = (what) => rig.log.some(l => l.includes("idle timer deferred, " + what));
  resetShot();
  return rig;
}
const tryRun = async (f) => { try { await f(); return "no error"; } catch (e) { return e.message; } };
// Lock taken, session up: the starting point of most idle cases.
async function idleRigUp(delays) {
  const rig = idleRig(delays);
  rig.ex.__setLockHeld(true);
  await sleep(60);
  return rig;
}

console.log("\n[27] idle: 120 s without a portal command ends the portal session, the lock stays");
{
  const rig = await idleRigUp();
  try {
    const armed = rig.clock.pending();
    ok(armed.length === 1 && armed[0].ms === IDLE_MS && armed[0].unrefd,
       "a session that comes up arms one unref'd 120 s timer", JSON.stringify(armed.map(t => ({ ms: t.ms, unref: t.unrefd }))));
    ok((await tryRun(rig.zoom)) === "no error", "a capture runs on the session");
    rig.clock.advance(IDLE_MS - 1);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 0, "119.999 s after the capture: still up", String(countCalls(rig, "session-end")));
    rig.clock.advance(1);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1 && rig.idleLogged(), "at 120 s: session-end, and it is logged",
       rig.log.filter(l => l.includes("idle")).join(" | "));
    ok(rig.log.some(l => l.includes("session ended")) && rig.clock.pending().length === 0,
       "the teardown completes and leaves no timer behind", String(rig.clock.pending().length));
  } finally { rig.restore(); }
}

console.log("\n[28] idle: activity within 120 s re-arms the timer (async capture and sync input)");
{
  const rig = await idleRigUp();
  try {
    rig.clock.advance(100000);
    await rig.zoom();
    rig.clock.advance(100000);                     // 200 s since the start, 100 s since the capture
    await sleep(30);
    ok(countCalls(rig, "session-end") === 0, "a capture 100 s in pushes the end out", String(countCalls(rig, "session-end")));
    await rig.ex.moveMouse(5, 5);
    rig.clock.advance(100000);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 0 && rig.sync.includes("pointer-move"), "so does sync input", rig.sync.join(" "));
    rig.clock.advance(20000);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1 && rig.idleLogged(), "120 s after the last input it ends",
       String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}

console.log("\n[29] idle: the stop-sharing latch lifts after 120 s; blocked commands do not re-arm it");
{
  const rig = await idleRigUp();
  try {
    rig.stop.on = true;                            // the user clicked "Stop sharing"
    let msg = await tryRun(() => rig.ex.moveMouse(5, 5));
    ok(msg === STOPPED_MSG, "the stop latches (sync input reads the stop message)", msg);
    rig.clock.advance(60000);
    const spawned = rig.sync.length;
    msg = await tryRun(() => rig.ex.moveMouse(5, 5));
    const shot = await shotText({});
    ok(msg === STOPPED_MSG && shot.includes(STOPPED_MSG) && rig.sync.length === spawned && countCalls(rig, "zoom") === 0,
       "60 s later the model retries: refused fast, nothing spawned", rig.sync.join(" "));
    rig.clock.advance(60000);                      // 120 s after the stop, 60 s after the retries
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1, "120 s after the stop: session-end removes the marker", String(countCalls(rig, "session-end")));
    ok(rig.log.some(l => l.includes("stopped-by-user latch cleared (idle)")), "and the latch is cleared (idle)");
    rig.stop.on = false;                           // session-end removed the marker
    msg = await tryRun(() => rig.ex.moveMouse(5, 5));
    ok(msg === "no error" && rig.sync.slice(-2).join(" ") === "session-start pointer-move",
       "the next input starts a session (sync backstop) and runs", rig.sync.join(" "));
  } finally { rig.restore(); }
}

console.log("\n[29b] idle: a stop latched while a button is held or a command is in flight still lifts at 120 s");
{
  const rig = await idleRigUp({ zoom: 200 });
  try {
    await rig.ex.mouseDown();                      // a button is held
    const z = tryRun(rig.zoom);                    // a capture in flight
    await sleep(40);
    rig.stop.on = true;                            // the user clicked "Stop sharing"
    const msg = await tryRun(() => rig.ex.moveMouse(5, 5));
    ok(msg === STOPPED_MSG, "the stop latches", msg);
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1 && rig.log.some(l => l.includes("stopped-by-user latch cleared (idle)")),
       "the daemon is gone: neither the held button nor the capture in flight defers the lift",
       rig.log.filter(l => l.includes("idle")).join(" | "));
    await z;
  } finally { rig.restore(); }
}

console.log("\n[29c] idle: a session-start that exits 5 (async or sync backstop) arms the timer that lifts the latch");
{
  const rig = idleRig();
  rig.stop.start = true;
  try {
    rig.ex.__setLockHeld(true);                    // async start, closed before ready
    await sleep(60);
    ok(rig.log.some(l => l.includes("screen sharing was stopped (session-start exit 5)")) && rig.clock.pending().length === 1,
       "async start exit 5: latched, timer armed", String(rig.clock.pending().length));
    rig.stop.start = false;
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1 && rig.log.some(l => l.includes("stopped-by-user latch cleared (idle)")),
       "120 s later the latch lifts", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}
{
  const rig = idleRig();
  rig.stop.start = true;
  try {
    const msg = await tryRun(() => rig.ex.moveMouse(5, 5));   // no lock hook: the sync backstop starts
    ok(msg === STOPPED_MSG && rig.clock.pending().length === 1, "sync backstop exit 5: latched, timer armed", msg);
    rig.stop.start = false;
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1 && rig.log.some(l => l.includes("stopped-by-user latch cleared (idle)")),
       "120 s later the latch lifts", String(countCalls(rig, "session-end")));
    const m2 = await tryRun(() => rig.ex.moveMouse(5, 5));
    ok(m2 === "no error", "and input works again", m2);
  } finally { rig.restore(); }
}

console.log("\n[30] idle: never ends a session while a start, an end or a portal command is in flight");
{
  // A command in flight (a slow capture).
  const delays = { zoom: 150 };
  const rig = await idleRigUp(delays);
  try {
    const z = rig.zoom();
    await sleep(40);                               // the zoom is spawned and pending
    rig.clock.advance(IDLE_MS);
    await sleep(10);
    ok(countCalls(rig, "session-end") === 0 && rig.deferred("a portal command"),
       "a capture in flight: deferred, no session-end", String(countCalls(rig, "session-end")));
    ok(rig.clock.pending().length === 1, "and the timer is re-armed");
    await z;
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1, "once it settled, 120 s idle ends the session", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}
{
  // A start in flight: the daemon vanished, the next capture starts a new one.
  const clockS = makeClock();
  const rig = makeRig(150, (sub) => sub === "screens" ? screensJson([true, true]) : sub === "zoom" ? ZOOM_OK : "{}", EDISPLAYS, undefined, clockS);
  resetShot();
  rig.ex.__setLockHeld(true);
  await sleep(220);                                // the lock's session is up
  rigSocket.present = false;                       // the daemon is gone
  try {
    const z = rig.ex.zoom({ x: 10, y: 10, w: 10, h: 10 }, 1, null);
    await sleep(30);
    rigSocket.present = true;
    ok(countCalls(rig, "session-start") === 2, "a replacement session-start is in flight", String(countCalls(rig, "session-start")));
    clockS.advance(IDLE_MS);
    await sleep(10);
    ok(countCalls(rig, "session-end") === 0 && rig.log.some(l => l.includes("idle timer deferred, a session-start")),
       "a start in flight: deferred, no session-end", String(countCalls(rig, "session-end")));
    await z;
    await sleep(30);
  } finally { rigSocket.present = true; rig.restore(); }
}
{
  // An end in flight (the lock release), with a sync command landing in it.
  // The bridge has no session to run it on and answers exit 4, as a real one
  // would; the command still settled, so it re-arms the timer either way.
  const rig = await idleRigUp({ "session-end": 150 });
  try {
    const rel = rig.ex.__setLockHeld(false);
    await sleep(20);
    rig.onSync = (sub) => { if (sub === "pointer-move") throw Object.assign(new Error("Command failed: pointer-move\nno live portal session"), { status: 4 }); };
    await tryRun(() => rig.ex.moveMouse(5, 5));    // the backstop declines; the bridge answers exit 4
    rig.onSync = null;
    ok(rig.sync.includes("pointer-move") && rig.clock.pending().length === 1, "the command landing in the end re-armed the timer",
       rig.sync.join(" "));
    rig.clock.advance(IDLE_MS);
    await sleep(10);
    ok(rig.deferred("a session-end") && countCalls(rig, "session-end") === 1,
       "an end in flight: deferred, no second session-end", rig.log.filter(l => l.includes("idle")).join(" | "));
    await rel;
    ok(rig.clock.pending().length === 0, "the finished end leaves no timer", String(rig.clock.pending().length));
  } finally { rig.restore(); }
}

{
  // A capture enumerates monitors (`screens`, portal-free) before its zoom:
  // the session must not end in that gap and be restarted for the zoom.
  const rig = await idleRigUp({ screens: 150 });
  try {
    const z = tryRun(rig.zoom);
    await sleep(40);                               // screens pending, zoom not spawned yet
    rig.clock.advance(IDLE_MS);
    await sleep(10);
    ok(countCalls(rig, "session-end") === 0 && rig.deferred("a bridge query"),
       "a capture enumerating monitors: deferred, no session-end", rig.log.filter(l => l.includes("idle")).join(" | "));
    const r = await z;
    ok(r === "no error" && countCalls(rig, "session-start") === 1 && countCalls(rig, "zoom") === 1,
       "the capture runs on the same session, no restart", `start ${countCalls(rig, "session-start")}`);
  } finally { rig.restore(); }
}

console.log("\n[31] idle: never ends a session while a mouse button or a key is held");
{
  const rig = await idleRigUp();
  try {
    await rig.ex.mouseDown();                      // left_mouse_down, no left_mouse_up yet
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 0 && rig.deferred("a held mouse button"),
       "button held: deferred, no session-end", rig.sync.join(" "));
    await rig.ex.moveMouse(5, 5);                  // an action while held: the one deferral is available again
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 0 && rig.log.filter(l => l.includes("idle timer deferred, a held mouse button")).length === 2,
       "a portal command in between: the next expiry defers again", String(countCalls(rig, "session-end")));
    await rig.ex.mouseUp();
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1, "120 s after left_mouse_up the session ends", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}
{
  // Held deferral applies once: a model that holds a button for two idle
  // periods without any action has abandoned it.
  const rig = await idleRigUp();
  try {
    await rig.ex.mouseDown();
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 0 && rig.deferred("a held mouse button"), "first expiry with a held button: deferred",
       String(countCalls(rig, "session-end")));
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1 && rig.log.some(l => l.includes("held for 240 s without a Computer Use action, ending the portal session anyway")),
       "second expiry with no action in between: the session ends, and it is logged", String(countCalls(rig, "session-end")));
    const msg = await tryRun(() => rig.ex.mouseDown());
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(msg === "no error" && rig.deferred("a held mouse button") && countCalls(rig, "session-end") === 1,
       "the next session gets its own deferral (the flag was reset)", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}
{
  // A FAILED left_mouse_down holds nothing.
  const rig = await idleRigUp();
  try {
    rig.onSync = (sub) => { if (sub === "left-mouse-down") throw new Error("Command failed: left-mouse-down\ninput rejected"); };
    const msg = await tryRun(() => rig.ex.mouseDown());
    rig.onSync = null;
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(msg !== "no error" && countCalls(rig, "session-end") === 1 && !rig.deferred("a held mouse button"),
       "a failed left_mouse_down leaves the flag clear: 120 s later the session ends", msg);
  } finally { rig.restore(); }
}
{
  // A FAILED left_mouse_up still releases the hold for the idle timer.
  const rig = await idleRigUp();
  try {
    await rig.ex.mouseDown();
    rig.onSync = (sub) => { if (sub === "left-mouse-up") throw new Error("Command failed: left-mouse-up\ninput rejected"); };
    const msg = await tryRun(() => rig.ex.mouseUp());
    rig.onSync = null;
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(msg !== "no error" && countCalls(rig, "session-end") === 1 && !rig.deferred("a held mouse button"),
       "a failed left_mouse_up clears the flag: 120 s later the session ends", msg);
  } finally { rig.restore(); }
}
{
  // hold_key is ONE hold-key command that releases the key itself: the timer
  // coming due while it runs must find it in flight.
  const rig = await idleRigUp();
  try {
    rig.onSync = (sub) => { if (sub === "hold-key") rig.clock.advance(IDLE_MS); };
    await rig.ex.holdKey("shift", 2);
    rig.onSync = null;
    await sleep(30);
    ok(countCalls(rig, "session-end") === 0 && rig.deferred("a portal command"),
       "key held (hold-key running): deferred, no session-end", rig.sync.join(" "));
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1, "120 s after the key was released the session ends", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}

console.log("\n[32] idle: a lock release cancels the timer; a new lock arms a fresh one");
{
  const rig = await idleRigUp();
  try {
    ok(rig.clock.pending().length === 1, "armed while the lock's session is up", String(rig.clock.pending().length));
    await rig.ex.__setLockHeld(false);
    await sleep(30);
    ok(rig.clock.pending().length === 0, "the release cancels it", String(rig.clock.pending().length));
    rig.clock.advance(3 * IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1 && !rig.idleLogged(), "only the release's session-end, no idle end",
       String(countCalls(rig, "session-end")));
    rig.ex.__setLockHeld(true);
    await sleep(60);
    ok(rig.clock.pending().length === 1 && countCalls(rig, "session-start") === 2, "a new lock: new session, one timer",
       String(rig.clock.pending().length));
  } finally { rig.restore(); }
}

console.log("\n[33] idle: the next command after an idle end restarts the session (no \"stopped\" state)");
{
  const rig = await idleRigUp();
  try {
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1, "idle end", String(countCalls(rig, "session-end")));
    const shot = await handler("screenshot", {});
    ok(shot && shot.content && shot.content.some((b) => b.type === "image") && countCalls(rig, "session-start") === 2,
       "a screenshot: the lazy (async) start brings a session back and captures", String(countCalls(rig, "session-start")));
    ok(rig.clock.pending().length === 1, "and the new session is timed again");
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 2, "idle end again", String(countCalls(rig, "session-end")));
    const before = rig.sync.length;
    const msg = await tryRun(() => rig.ex.moveMouse(5, 5));
    ok(msg === "no error" && rig.sync.slice(before).join(" ") === "session-start pointer-move",
       "sync input: the backstop starts a session, then the move runs", rig.sync.join(" "));
    ok(!rig.log.some(l => l.includes("portal session unavailable") || l.includes("screen sharing was stopped")),
       "no cooldown, no stop latch after an idle end");
  } finally { rig.restore(); }
}

console.log("\n[33b] idle: an async capture or a new lock arriving during an idle end waits for it, then starts");
{
  const rig = await idleRigUp({ "session-end": 150 });
  try {
    rig.clock.advance(IDLE_MS);                    // idle end in flight
    await sleep(20);
    ok(countCalls(rig, "session-end") === 1, "the idle end is in flight", String(countCalls(rig, "session-end")));
    const r = await tryRun(rig.zoom);
    const seq = calls(rig.log);
    ok(r === "no error" && countCalls(rig, "session-start") === 2 && seq.indexOf("DONE session-end") < seq.lastIndexOf("CALL session-start"),
       "a capture racing the end: queued behind it, then a fresh session and the capture", seq.join(" "));
    ok(rig.log.some(l => l.includes("session-start queued behind an in-flight session-end")), "the wait is logged");
    ok(rig.clock.pending().length === 1, "and the new session is timed", String(rig.clock.pending().length));
  } finally { rig.restore(); }
}
{
  const rig = await idleRigUp({ "session-end": 150 });
  try {
    rig.clock.advance(IDLE_MS);                    // idle end in flight
    await sleep(20);
    await rig.ex.__setLockHeld(true);              // the next task's lock
    await sleep(30);
    const seq = calls(rig.log);
    ok(countCalls(rig, "session-start") === 2 && seq.indexOf("DONE session-end") < seq.lastIndexOf("CALL session-start"),
       "a new lock during an idle end: a session-start after the end", seq.join(" "));
    ok(seq[seq.length - 1] === "DONE session-start" && rig.clock.pending().length === 1,
       "the run ends with the session UP and one timer", seq.join(" "));
    const r = await tryRun(rig.zoom);
    ok(r === "no error" && countCalls(rig, "session-start") === 2, "and it captures on that session, no further start", r);
  } finally { rig.restore(); }
}

console.log("\n[33c] idle, no restore token: a sync start that outlasts its 8 s budget continues in the background");
{
  // After an idle end the next action is a click; without a restore token the
  // blocking sync start raises the consent dialog and times out while the user
  // is still answering it. That is not a portal fault: no cooldown, the async
  // start takes the dialog over, and the model is told to have the user approve.
  const timedOut = () => Object.assign(new Error("spawnSync /res/gnome-portal-bridge ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM", status: null });
  const rig = await idleRigUp();
  try {
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    ok(countCalls(rig, "session-end") === 1, "idle end", String(countCalls(rig, "session-end")));
    rig.onSync = (sub) => { if (sub === "session-start") throw timedOut(); };
    const msg = await tryRun(() => rig.ex.click(5, 5, "left", 1));
    rig.onSync = null;
    ok(/approve the screen-sharing dialog, then retry the action/.test(msg), "the model is told to have the user approve, then retry", msg);
    ok(!rig.log.some(l => l.includes("portal session unavailable")), "no portal-down cooldown");
    ok(!rig.sync.includes("pointer-click"), "the click is not sent", rig.sync.join(" "));
    ok(countCalls(rig, "session-start") === 2, "the async start takes over (full budget)", String(countCalls(rig, "session-start")));
    await sleep(60);                               // the user approved
    const before = rig.sync.length;
    const m2 = await tryRun(() => rig.ex.click(5, 5, "left", 1));
    ok(m2 === "no error" && !rig.sync.slice(before).includes("session-start") && rig.sync.slice(before).includes("pointer-click"),
       "the retry runs on that session, no further start", rig.sync.slice(before).join(" "));
  } finally { rig.restore(); }
}
{
  // A genuine failure (the bridge gave up on its own, no daemon left): cooldown, as before.
  const rig = await idleRigUp();
  try {
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    rig.onSync = (sub) => { if (sub === "session-start") throw Object.assign(new Error("Command failed: session-start\nno RemoteDesktop portal"), { status: 1 }); };
    await tryRun(() => rig.ex.click(5, 5, "left", 1));
    rig.onSync = null;
    ok(rig.log.some(l => l.includes("portal session unavailable")) && countCalls(rig, "session-start") === 1,
       "no daemon left: the portal is marked down, no background start", String(countCalls(rig, "session-start")));
  } finally { rig.restore(); }
}
{
  // The bridge failed on its own but its daemon (pidfile, live pid) is still up.
  const rig = await idleRigUp();
  try {
    rig.clock.advance(IDLE_MS);
    await sleep(30);
    rig.onSync = (sub) => { if (sub === "session-start") { rigSocket.pid = process.pid; throw Object.assign(new Error("Command failed: session-start\ntimed out waiting for the portal"), { status: 1 }); } };
    const msg = await tryRun(() => rig.ex.click(5, 5, "left", 1));
    rig.onSync = null;
    ok(/approve the screen-sharing dialog/.test(msg) && !rig.log.some(l => l.includes("portal session unavailable")),
       "a live daemon pid: same hand-over, no cooldown", msg);
    await sleep(60);
  } finally { rigSocket.pid = null; rig.restore(); }
}

console.log("\n[34] __cuTaskBoundary: same session (alias ids) ends the portal session; another session is ignored");
{
  const call = async (rig, id, source, holder) => {
    if (typeof rig.ex.__cuTaskBoundary !== "function") return "missing";
    const r = rig.ex.__cuTaskBoundary(id, source, holder);
    if (!r || typeof r.then !== "function") return "not async";
    await r; await sleep(30);
    return "ok";
  };
  let rig = await idleRigUp();
  try {
    let r = await call(rig, "session_ABC", "renderer", "cse_abc");
    ok(r === "ok" && countCalls(rig, "session-end") === 1, "session_ABC vs cse_abc: same session, session-end", r);
    ok(rig.log.some(l => l.includes("[claude-cu] task boundary (renderer): ending the portal session")), "and it is logged");
    ok(rig.clock.pending().length === 0, "the idle timer is cancelled with it");
  } finally { rig.restore(); }
  rig = await idleRigUp();
  try {
    let r = await call(rig, "session_ABC", "renderer", "cse_xyz");
    ok(r === "ok" && countCalls(rig, "session-end") === 0, "another session's id: ignored", r);
    ok(rig.log.some(l => l.includes("task boundary (renderer): ignored")), "and the mismatch is logged");
    r = await call(rig, undefined, "stop_click", "cse_xyz");
    ok(r === "ok" && countCalls(rig, "session-end") === 1, "no id (Stop): acts", r);
  } finally { rig.restore(); }
  rig = await idleRigUp();
  try {
    const r = await call(rig, "cse_abc", "renderer", undefined);
    ok(r === "ok" && countCalls(rig, "session-end") === 1, "no lock holder: acts", r);
  } finally { rig.restore(); }
  rig = await idleRigUp();
  try {
    rig.stop.on = true;
    await tryRun(() => rig.ex.moveMouse(5, 5));    // latched
    const r = await call(rig, "session_q", "renderer", "SESSION_Q");
    ok(r === "ok" && countCalls(rig, "session-end") === 1 && rig.log.some(l => l.includes("stopped-by-user latch cleared (task boundary)")),
       "a stop-sharing latch is lifted at the task boundary", r);
    rig.stop.on = false;
    const msg = await tryRun(() => rig.ex.moveMouse(5, 5));
    ok(msg === "no error", "and the next action shares again", msg);
  } finally { rig.restore(); }
  rig = await idleRigUp();
  const savedDe = process.env.XDG_CURRENT_DESKTOP;
  try {
    process.env.XDG_CURRENT_DESKTOP = "KDE";
    const r = await call(rig, undefined, "renderer", undefined);
    process.env.XDG_CURRENT_DESKTOP = savedDe;
    ok(r === "ok" && countCalls(rig, "session-end") === 0 && !rig.log.some(l => l.includes("task boundary") && !l.includes("): received ")),
       "off GNOME: a no-op (only the received diagnostic line)", r);
  } finally { process.env.XDG_CURRENT_DESKTOP = savedDe; rig.restore(); }
}

// ── Cloud-session check (js/cu_session_check.js, #293 round 8) ──
// While a portal session is up for a cloud lock holder, the shared poller asks
// upstream's session-state check (globalThis.__cdbRemoteSessionMode, exposed by
// sub-patch 4f) 10 s after the last portal command; an ended session goes
// through __cuTaskBoundary(holder, "session-check", holder). Result keys come
// from upstream's refreshRemoteChromeSessionMode: ended / ok / transient /
// notFound. All its timers run on the rig's virtual clock (clock.hold).
const SESSION_CHECK = path.join(ROOT, "js", "cu_session_check.js");
function loadSessionCheck() {
  if (!globalThis.__cdbCuSessionCheck) new Function(readFileSync(SESSION_CHECK, "utf8"))();
  return globalThis.__cdbCuSessionCheck;
}
const RUNNING = { ok: true, ended: false, transient: false, notFound: false };
const ENDED = { ok: true, ended: true, transient: false, notFound: false };
// results: function (id, n) -> result | Error (thrown). opts.holder (default
// cse_X), opts.noAccessor (no 4f accessor at all), opts.noCommand.
async function checkRig(results, opts = {}) {
  const rig = idleRig(opts.delays);
  const sc = loadSessionCheck();
  sc._seam({ setTimeout: rig.clock.hold, clearTimeout: rig.clock.clearTimeout, now: rig.clock.now });
  rig.requests = [];
  if (opts.noAccessor) delete globalThis.__cdbRemoteSessionMode;
  else globalThis.__cdbRemoteSessionMode = async () => ({
    resolve: async () => ({}),
    refresh: async (id) => { rig.requests.push(id); const r = results(id, rig.requests.length); if (r instanceof Error) throw r; return r; }
  });
  rig.ex.__setLockHeld(true, "holder" in opts ? opts.holder : "cse_X");
  await sleep(60);
  if (!opts.noCommand) await rig.zoom();
  // Virtual seconds, one at a time, letting the async check settle in between.
  rig.tick = async (secs) => { for (let i = 0; i < secs; i++) { rig.clock.advance(1000); for (let j = 0; j < 8; j++) await new Promise(r => setImmediate(r)); } await sleep(20); };
  // The poll/stop lines; the arm decisions (armed / not armed) have their own list.
  const isDecision = (l) => /session check: (armed for |not armed )/.test(l);
  rig.checkLog = () => rig.log.filter(l => l.includes("[claude-cu] session check:") && !isDecision(l));
  // The rig prefixes diag lines with "DIAG ": the new-line helpers return the bare text.
  const bare = (l) => l.replace(/^DIAG /, "");
  rig.decisionLog = () => rig.log.filter(isDecision).map(bare);
  rig.lockLog = () => rig.log.map(bare).filter(l => /^\[claude-cu\] lock (taken by|released)/.test(l));
  const restore = rig.restore;
  rig.restore = () => { sc._seam(); delete globalThis.__cdbRemoteSessionMode; restore(); };
  return rig;
}

console.log("\n[35] session check: first check 10 s after the last command; ended -> the portal session ends once");
{
  const rig = await checkRig(() => ENDED);
  try {
    await rig.tick(9);
    ok(rig.requests.length === 0, "nothing asked 9 s after the command", rig.requests.join(" "));
    await rig.tick(1);
    ok(rig.requests.length === 1 && rig.requests[0] === "cse_X", "at 10 s: one check for cse_X", rig.requests.join(" "));
    ok(countCalls(rig, "session-end") === 1, "ended: session-end", String(countCalls(rig, "session-end")));
    ok(rig.log.some(l => l.includes("[claude-cu] session check: cse_X ended, ending the portal session")), "the end is logged");
    ok(rig.log.some(l => l.includes("[claude-cu] task boundary (session-check): ending the portal session")),
       "through the task boundary", rig.log.filter(l => l.includes("task boundary")).join(" | "));
    await rig.tick(40);
    ok(rig.requests.length === 1 && countCalls(rig, "session-end") === 1, "no further checks or ends until the next arm",
       rig.requests.length + " / " + countCalls(rig, "session-end"));
    ok((await tryRun(rig.zoom)) === "no error" && countCalls(rig, "session-start") === 2, "the next command starts a session again");
    await rig.tick(10);
    ok(rig.requests.length === 2, "and arms the check again", String(rig.requests.length));
  } finally { rig.restore(); }
}

console.log("\n[36] session check: a running session is left alone, checked every 10 s, without log lines");
{
  const rig = await checkRig(() => RUNNING);
  try {
    await rig.tick(35);
    ok(rig.requests.length === 3, "checks at 10, 20 and 30 s", String(rig.requests.length));
    ok(countCalls(rig, "session-end") === 0, "no session-end", String(countCalls(rig, "session-end")));
    ok(rig.checkLog().length === 0, "no per-check log line", rig.checkLog().join(" | "));
    const armed = rig.clock.pending().filter(t => t.ms === 10000);
    ok(armed.length === 1 && armed[0].unrefd, "one unref'd 10 s timer stays armed", JSON.stringify(armed.map(t => t.unrefd)));
  } finally { rig.restore(); }
}

console.log("\n[37] session check: deferred while a command is in flight or a mouse button is held");
{
  const rig = await checkRig(() => ENDED, { delays: { zoom: 150 } });
  try {
    const p = rig.zoom();
    await sleep(20);
    await rig.tick(12);
    ok(rig.requests.length === 0 && countCalls(rig, "session-end") === 0, "a command in flight: no request", String(rig.requests.length));
    await p;
    await rig.tick(9);
    ok(rig.requests.length === 0, "the command's end re-arms: nothing 9 s after it", String(rig.requests.length));
    await rig.ex.mouseDown();
    await rig.tick(25);
    ok(rig.requests.length === 0 && countCalls(rig, "session-end") === 0, "a held button: no request", String(rig.requests.length));
    await rig.ex.mouseUp();
    await rig.tick(10);
    ok(rig.requests.length === 1 && countCalls(rig, "session-end") === 1, "released: checked and ended 10 s later",
       rig.requests.length + " / " + countCalls(rig, "session-end"));
  } finally { rig.restore(); }
}

console.log("\n[38] session check: errors back off to 20/40/60 s and never end the session");
{
  const rig = await checkRig((id, n) => n % 2 ? new Error("net::ERR_INTERNET_DISCONNECTED") : { ok: false, ended: false, transient: true, notFound: false });
  try {
    await rig.tick(10);
    ok(rig.requests.length === 1, "first check at 10 s", String(rig.requests.length));
    await rig.tick(19);
    ok(rig.requests.length === 1, "nothing before 30 s", String(rig.requests.length));
    await rig.tick(1);
    ok(rig.requests.length === 2, "second at 30 s (20 s)", String(rig.requests.length));
    await rig.tick(40);
    ok(rig.requests.length === 3, "third at 70 s (40 s)", String(rig.requests.length));
    await rig.tick(30);                             // t = 100 s: an action keeps the idle end away
    await rig.zoom();
    await rig.tick(59);
    ok(rig.requests.length === 3, "after an action the backed-off interval stays: nothing at 159 s", String(rig.requests.length));
    await rig.tick(1);
    ok(rig.requests.length === 4, "capped at 60 s: the next check at 160 s", String(rig.requests.length));
    await rig.tick(30);
    ok(rig.requests.length === 4, "and still 60 s after it (nothing at 190 s)", String(rig.requests.length));
    const backoff = rig.checkLog().filter(l => l.includes("backing off"));
    ok(backoff.length === 3 && /20 s/.test(backoff[0]) && /40 s/.test(backoff[1]) && /60 s/.test(backoff[2]),
       "one log line per change: 20, 40, 60 s", backoff.join(" | "));
    ok(countCalls(rig, "session-end") === 0, "an error never ends the session", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}

console.log("\n[39] session check: notFound stops the check for this holder; the idle timer still ends it");
{
  const rig = await checkRig(() => ({ ok: false, ended: false, transient: false, notFound: true }));
  try {
    await rig.tick(10);
    ok(rig.requests.length === 1 && rig.checkLog().length === 1 && rig.checkLog()[0].includes("cse_X"), "one check, logged once", rig.checkLog().join(" | "));
    await rig.tick(30);
    await rig.zoom();
    await rig.tick(30);
    ok(rig.requests.length === 1 && rig.checkLog().length === 1, "never asked again for this holder, even after an action", String(rig.requests.length));
    await rig.tick(91);
    ok(countCalls(rig, "session-end") === 1 && rig.idleLogged(), "the idle backstop ends it", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}
{
  // Any other non-2xx answers a bare {ok:false} (a 401 during a cookie
  // refresh; upstream caches it for 30 s): backed off like a transient error,
  // never a stop.
  const rig = await checkRig(() => ({ ok: false }));
  try {
    await rig.tick(40);
    ok(rig.requests.length === 2 && countCalls(rig, "session-end") === 0 && !rig.checkLog().some(l => l.includes("stopping")),
       "a bare {ok:false}: checked at 10 and 30 s, backed off, nothing ended", rig.requests.length + " / " + rig.checkLog().join(" | "));
  } finally { rig.restore(); }
}

console.log("\n[40] session check: a session_X holder is asked as cse_X and passes the task boundary's id check");
{
  const rig = await checkRig(() => ENDED, { holder: "session_01AbC" });
  try {
    await rig.tick(10);
    ok(rig.requests.join(" ") === "cse_01AbC", "request id cse_01AbC", rig.requests.join(" "));
    ok(countCalls(rig, "session-end") === 1 && !rig.log.some(l => l.includes("task boundary (session-check): ignored")),
       "ended: session-end, not ignored", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}

console.log("\n[41] session check: a hub-chat (UUID) holder or no holder is never checked");
for (const holder of ["3f2b6c1e-8d4a-4c3b-9e2f-1a2b3c4d5e6f", undefined]) {
  const rig = await checkRig(() => ENDED, { holder });
  try {
    await rig.tick(40);
    ok(rig.requests.length === 0 && rig.checkLog().length === 0 && countCalls(rig, "session-end") === 0,
       "holder " + holder + ": no check, no log", rig.requests.length + " / " + rig.checkLog().join(" | "));
  } finally { rig.restore(); }
}

console.log("\n[42] session check: a lock release, a session end or a task boundary stops it");
{
  let rig = await checkRig(() => ENDED);
  try {
    await rig.tick(5);
    await rig.ex.__setLockHeld(false);
    await sleep(30);
    await rig.tick(30);
    ok(rig.requests.length === 0, "lock released: no check", String(rig.requests.length));
    ok(rig.checkLog().filter(l => l.includes("stopped for cse_X (lock released)")).length === 1, "one stop line", rig.checkLog().join(" | "));
  } finally { rig.restore(); }
  rig = await checkRig(() => ENDED);
  try {
    await rig.tick(5);
    await rig.ex.__cuTaskBoundary("cse_X", "renderer", "cse_X");
    await sleep(30);
    await rig.tick(30);
    ok(rig.requests.length === 0 && countCalls(rig, "session-end") === 1, "renderer task boundary: no check after it", String(rig.requests.length));
  } finally { rig.restore(); }
  rig = await checkRig(() => RUNNING);
  try {
    await rig.tick(5);
    rig.clock.advance(IDLE_MS);                    // idle end (the check reschedules itself on the way)
    await sleep(30);
    const n = rig.requests.length;
    await rig.tick(30);
    ok(countCalls(rig, "session-end") === 1 && rig.requests.length === n, "idle end: the check stops with it", n + " -> " + rig.requests.length);
  } finally { rig.restore(); }
  rig = await checkRig(() => ENDED);
  try {
    // A reply that lands after the lock release is dropped.
    let release;
    globalThis.__cdbRemoteSessionMode = async () => ({ refresh: (id) => { rig.requests.push(id); return new Promise(r => { release = r; }); } });
    await rig.tick(10);
    ok(rig.requests.length === 1 && typeof release === "function", "a check in flight");
    await rig.ex.__setLockHeld(false);
    await sleep(30);
    if (typeof release === "function") release(ENDED);
    await sleep(30);
    ok(!rig.log.some(l => l.includes("session check: cse_X ended")) && countCalls(rig, "session-end") === 1,
       "its late 'ended' is ignored (only the release's session-end)", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}

console.log("\n[43] session check: with the stop-sharing latch set, an ended session lifts it through the task boundary");
{
  const rig = await checkRig((id, n) => n === 1 ? RUNNING : ENDED);
  try {
    rig.stop.on = true;
    ok((await tryRun(() => rig.ex.moveMouse(5, 5))).startsWith("Screen sharing was stopped"), "latched");
    await rig.tick(10);
    ok(rig.requests.length === 1 && countCalls(rig, "session-end") === 0, "running: the latch stays", String(countCalls(rig, "session-end")));
    await rig.tick(10);
    ok(rig.requests.length === 2 && countCalls(rig, "session-end") === 1 &&
       rig.log.some(l => l.includes("stopped-by-user latch cleared (task boundary)")),
       "ended: session-end and the latch is cleared", rig.log.filter(l => l.includes("latch")).join(" | "));
    rig.stop.on = false;
    ok((await tryRun(() => rig.ex.moveMouse(5, 5))) === "no error", "the next action shares again");
  } finally { rig.restore(); }
}

console.log("\n[44] session check: no session-state accessor (older patch set) -> never checks; the idle backstop ends at 120 s");
{
  const rig = await checkRig(() => ENDED, { noAccessor: true });
  try {
    await rig.tick(60);
    ok(rig.checkLog().length === 0 && rig.clock.pending().every(t => t.ms !== 10000), "no check armed, nothing logged", rig.checkLog().join(" | "));
    ok(countCalls(rig, "session-end") === 0, "still up at 60 s");
    await rig.tick(61);
    ok(countCalls(rig, "session-end") === 1 && rig.idleLogged(), "idle end at 120 s", String(countCalls(rig, "session-end")));
  } finally { rig.restore(); }
}

console.log("\n[45] session check: notFound lasts until the lock is released; the same holder on the next lock is checked again");
{
  let mode = "notFound";
  const rig = await checkRig(() => mode === "notFound" ? { ok: false, ended: false, transient: false, notFound: true } : ENDED);
  try {
    await rig.tick(10);
    ok(rig.requests.length === 1, "notFound at 10 s", String(rig.requests.length));
    await rig.ex.__setLockHeld(false); await sleep(40);
    mode = "ended";
    rig.ex.__setLockHeld(true, "cse_X"); await sleep(60);
    await rig.zoom();
    await rig.tick(10);
    ok(rig.requests.length === 2 && countCalls(rig, "session-end") === 2, "a new lock for cse_X: checked, ended",
       rig.requests.length + " / " + countCalls(rig, "session-end"));
  } finally { rig.restore(); }
}

console.log("\n[46] session check: an 'ended' reply that lands after a tool call began (its screens query) is dropped");
{
  let release;
  // No command yet: the lock's session start armed the check, and the zoom's
  // monitor list is not cached, so it starts with a `screens` query.
  const rig = await checkRig(() => ENDED, { delays: { screens: 200 }, noCommand: true });
  try {
    globalThis.__cdbRemoteSessionMode = async () => ({ refresh: (id) => { rig.requests.push(id); return new Promise(r => { release = r; }); } });
    await rig.tick(10);
    ok(rig.requests.length === 1 && typeof release === "function", "a check in flight");
    const p = tryRun(rig.zoom);                    // screens query first (200 ms), then the zoom
    await sleep(30);
    if (typeof release === "function") release(ENDED);
    const r = await p; await sleep(50);
    ok(r === "no error" && countCalls(rig, "session-end") === 0 && countCalls(rig, "session-start") === 1,
       "the zoom runs on its session: no session-end, no second session-start",
       r + " / end " + countCalls(rig, "session-end") + " / start " + countCalls(rig, "session-start"));
    globalThis.__cdbRemoteSessionMode = async () => ({ refresh: async (id) => { rig.requests.push(id); return ENDED; } });
    await rig.tick(10);
    ok(rig.requests.length === 2 && countCalls(rig, "session-end") === 1, "10 s after the zoom: checked again and ended",
       rig.requests.length + " / " + countCalls(rig, "session-end"));
  } finally { rig.restore(); }
}

console.log("\n[47] session check: a task boundary while a session-start is in flight leaves no check armed");
{
  const rig = await checkRig(() => RUNNING);
  try {
    await rig.ex.__cuTaskBoundary("cse_X", "renderer", "cse_X"); await sleep(40);
    const p = tryRun(rig.zoom);                    // lazy session-start (20 ms consent)
    await sleep(5);
    await rig.ex.__cuTaskBoundary("cse_X", "renderer", "cse_X");
    await p; await sleep(80);
    const n = rig.requests.length;
    await rig.tick(35);
    ok(countCalls(rig, "session-end") === 2 && rig.requests.length === n, "after the end: no check runs",
       "requests +" + (rig.requests.length - n) + " / end " + countCalls(rig, "session-end"));
  } finally { rig.restore(); }
}

console.log("\n[48] session check: a backed-off interval does not carry into the next turn");
{
  const rig = await checkRig((id, n) => n === 1 ? new Error("net::ERR_NETWORK_CHANGED") : ENDED);
  try {
    await rig.tick(30);
    ok(rig.requests.length === 2 && countCalls(rig, "session-end") === 1, "error at 10 s, ended at 30 s", rig.requests.length + " / " + countCalls(rig, "session-end"));
    await rig.zoom();                              // next turn: new session
    await rig.tick(10);
    ok(rig.requests.length === 3, "the next turn is checked 10 s after its command", String(rig.requests.length));
  } finally { rig.restore(); }
}

// ── #293 round 9: the lock and the session check are observable ──
// Every line goes through __cdbDiag (rig.log). The triggers are the real ones:
// __setLockHeld (the lock hook), portal commands (rig.zoom arms the check) and
// the poll replies.
const NOT_ARMED_NONE = "[claude-cu] session check: not armed (no Computer Use lock holder; the portal session was started outside the lock)";

console.log("\n[49] diagnostics: lock taken/released lines carry the holder, on entry; one 'armed' line per lock");
{
  const rig = await checkRig(() => RUNNING);
  try {
    await rig.zoom(); await rig.zoom();
    ok(rig.lockLog().length === 1 && rig.lockLog()[0] === "[claude-cu] lock taken by cse_X", "lock taken by cse_X, once", rig.lockLog().join(" | "));
    ok(rig.decisionLog().length === 1 && rig.decisionLog()[0] === "[claude-cu] session check: armed for cse_X",
       "armed for cse_X logged once although every command arms (dedup)", rig.decisionLog().join(" | "));
    await rig.ex.__setLockHeld(false); await sleep(40);
    ok(rig.lockLog().length === 2 && rig.lockLog()[1] === "[claude-cu] lock released", "lock released", rig.lockLog().join(" | "));
    rig.ex.__setLockHeld(true, "cse_X"); await sleep(60);
    await rig.zoom(); await rig.zoom();
    ok(rig.lockLog()[2] === "[claude-cu] lock taken by cse_X", "the same holder taken again is logged again", rig.lockLog().join(" | "));
    ok(rig.decisionLog().length === 2, "the dedup reset on release: armed for cse_X logs again for the new lock", rig.decisionLog().join(" | "));
  } finally { rig.restore(); }
}

console.log("\n[50] diagnostics: lock taken without a holder is 'none'");
{
  const rig = await checkRig(() => RUNNING, { holder: undefined, noCommand: true });
  try {
    ok(rig.lockLog()[0] === "[claude-cu] lock taken by none", "lock taken by none", rig.lockLog().join(" | "));
    await rig.ex.__setLockHeld(false); await sleep(30);
    ok(rig.lockLog()[1] === "[claude-cu] lock released", "released", rig.lockLog().join(" | "));
  } finally { rig.restore(); }
}

console.log("\n[51] diagnostics: each not-armed reason is logged once per (holder, reason), also with no holder");
{
  let rig = await checkRig(() => RUNNING, { holder: undefined });
  try {
    await rig.zoom(); await rig.zoom(); await rig.tick(15);
    ok(rig.decisionLog().length === 1 && rig.decisionLog()[0] === NOT_ARMED_NONE, "no holder: one 'not armed' line, deduplicated over every command",
       rig.decisionLog().join(" | "));
    ok(rig.requests.length === 0, "and nothing is checked", String(rig.requests.length));
    await rig.ex.__setLockHeld(false); await sleep(30);
    rig.ex.__setLockHeld(true); await sleep(60); await rig.zoom();
    ok(rig.decisionLog().filter(l => l === NOT_ARMED_NONE).length === 2, "a new lock without a holder logs again", rig.decisionLog().join(" | "));
  } finally { rig.restore(); }
  const uuid = "3f2b6c1e-8d4a-4c3b-9e2f-1a2b3c4d5e6f";
  rig = await checkRig(() => RUNNING, { holder: uuid });
  try {
    await rig.zoom(); await rig.zoom();
    ok(rig.decisionLog().length === 1 && rig.decisionLog()[0] === "[claude-cu] session check: not armed (holder " + uuid + " is not a cloud session)",
       "UUID holder: not a cloud session, once", rig.decisionLog().join(" | "));
  } finally { rig.restore(); }
  rig = await checkRig(() => RUNNING, { noAccessor: true });
  try {
    await rig.zoom(); await rig.zoom();
    ok(rig.decisionLog().length === 1 && rig.decisionLog()[0] === "[claude-cu] session check: not armed (the session-state check is not available)",
       "no accessor: not available, once", rig.decisionLog().join(" | "));
  } finally { rig.restore(); }
  rig = await checkRig(() => ({ ok: false, ended: false, transient: false, notFound: true }));
  try {
    await rig.tick(10);
    await rig.zoom(); await rig.zoom();
    const nk = "[claude-cu] session check: not armed (holder cse_X is not known to the server)";
    ok(rig.decisionLog().filter(l => l === nk).length === 1, "notFound holder: 'not known to the server' once, although every command re-arms",
       rig.decisionLog().join(" | "));
    ok(rig.requests.length === 1, "behaviour unchanged: never asked again", String(rig.requests.length));
    await rig.ex.__setLockHeld(false); await sleep(30);
    rig.ex.__setLockHeld(true, "cse_X"); await sleep(60); await rig.zoom();
    ok(rig.decisionLog().filter(l => l.includes("armed for cse_X")).length === 2, "the next lock arms again (and logs it)", rig.decisionLog().join(" | "));
  } finally { rig.restore(); }
}

console.log("\n[52] diagnostics: a task boundary stops the check and resets the dedup");
{
  const rig = await checkRig(() => RUNNING);
  try {
    await rig.zoom();
    await rig.ex.__cuTaskBoundary("cse_X", "renderer", "cse_X"); await sleep(40);
    await rig.zoom(); await rig.zoom();
    ok(rig.decisionLog().filter(l => l.includes("armed for cse_X")).length === 2,
       "a task boundary stops the check; the next session arms and logs again", rig.decisionLog().join(" | "));
  } finally { rig.restore(); }
}

console.log("\n[53] diagnostics: per-poll lines only with CDB_CU_DEBUG=1");
{
  const pollLines = (rig) => rig.log.filter(l => /session check: cse_X -> /.test(l)).map(l => l.replace(/^DIAG /, ""));
  let rig = await checkRig(() => RUNNING);
  try {
    await rig.tick(35);
    ok(rig.requests.length === 3 && pollLines(rig).length === 0, "off: three polls, no per-poll line", pollLines(rig).join(" | "));
  } finally { rig.restore(); }
  process.env.CDB_CU_DEBUG = "1";
  try {
    rig = await checkRig(() => RUNNING);
    try {
      await rig.tick(35);
      ok(pollLines(rig).length === 3 && pollLines(rig).every(l => l === "[claude-cu] session check: cse_X -> ok=true ended=false next in 10 s"),
         "on: one line per poll", pollLines(rig).join(" | "));
    } finally { rig.restore(); }
    rig = await checkRig((id, n) => n === 1 ? { ok: false, ended: false, transient: true, notFound: false } : ENDED);
    try {
      await rig.tick(30);
      ok(pollLines(rig)[0] === "[claude-cu] session check: cse_X -> ok=false ended=false transient next in 20 s", "transient, with the backed-off interval", pollLines(rig).join(" | "));
      ok(pollLines(rig)[1] === "[claude-cu] session check: cse_X -> ok=true ended=true", "ended", pollLines(rig).join(" | "));
    } finally { rig.restore(); }
    rig = await checkRig(() => ({ ok: false, ended: false, transient: false, notFound: true }));
    try {
      await rig.tick(10);
      ok(pollLines(rig).length === 1 && pollLines(rig)[0] === "[claude-cu] session check: cse_X -> ok=false ended=false notFound", "notFound", pollLines(rig).join(" | "));
    } finally { rig.restore(); }
    rig = await checkRig(() => ENDED, { delays: { zoom: 150 } });
    try {
      const p = rig.zoom(); await sleep(20);
      await rig.tick(12);
      ok(pollLines(rig).some(l => l === "[claude-cu] session check: cse_X -> busy-skip next in 10 s"), "busy-skip", pollLines(rig).join(" | "));
      await p;
    } finally { rig.restore(); }
  } finally { delete process.env.CDB_CU_DEBUG; }
}

console.log("\n[54] GNOME: a PipeWire frame timeout through the tool handler - one retry, no desktopCapturer, the session stays up");
{
  const FRAME = "timed out waiting for PipeWire frame on stream 64 (state events: stream 64 -> Connecting, stream 64 -> Paused, stream 64 -> Streaming)";
  const st = { failZooms: 0 };
  const rig = makeRig(20, (sub) => {
    if (sub === "screens") return screensJson([true, true]);
    if (sub === "zoom") {
      if (st.failZooms > 0) { st.failZooms--; throw Object.assign(new Error("Command failed: zoom\n" + FRAME + "\n"), { code: 1, stderr: FRAME + "\n" }); }
      return ZOOM_OK;
    }
    return "{}";
  }, EDISPLAYS);
  resetShot();
  rig.ex.__setLockHeld(true, "local_frame");
  await sleep(60);
  st.failZooms = 1;
  let z0 = countCalls(rig, "zoom");
  let r = await handler("screenshot", {});
  ok(r && r.content && r.content.some((b) => b.type === "image") && countCalls(rig, "zoom") === z0 + 2, "one frame timeout: the second zoom captures", String(countCalls(rig, "zoom") - z0));
  st.failZooms = 2;
  z0 = countCalls(rig, "zoom");
  const cap0 = rig.log.filter(l => l === "CAPTURER").length;
  const text = await shotText({});
  ok(countCalls(rig, "zoom") === z0 + 2 && rig.log.filter(l => l === "CAPTURER").length === cap0, "two in a row: two zooms, no desktopCapturer (no Share Screen dialog)", (countCalls(rig, "zoom") - z0) + " zoom(s)");
  ok(text.includes("could not capture the screen (" + FRAME) && text.includes("taking the screenshot again once is reasonable") && !text.includes("every capture tier failed"), "the model reads that the capture failed and may retry", text);
  ok(countCalls(rig, "session-end") === 0, "the portal session is left up for the retry", String(countCalls(rig, "session-end")));
  st.failZooms = 0;
  r = await handler("screenshot", {});
  ok(r && r.content && r.content.some((b) => b.type === "image"), "and the model's retry captures");
  rig.ex.__setLockHeld(false);
  await sleep(40);
  rig.restore && rig.restore();
}

console.log("\n[55] the dock of a maximized window: a late window-manager restore is undone once (GNOME VM: 1 of 14 cycles)");
{
  const { EventEmitter } = await import("node:events");
  // A BrowserWindow stand-in: methods on the prototype (as in Electron, so an
  // instance-level wrapper shadows them), 'resize' on every size change.
  class Win extends EventEmitter {
    constructor(b) { super(); this.b = { ...b }; this.max = false; this.top = false; this.calls = []; }
    isDestroyed() { return false; } isVisible() { return true; } isFocusable() { return true; }
    isAlwaysOnTop() { return this.top; } isMaximized() { return this.max; } isFullScreen() { return false; } isMinimized() { return false; }
    getBounds() { return { ...this.b }; }
    setBounds(b) { this.calls.push("setBounds " + b.width + "x" + b.height); if (this.frozen) return; this.b = { ...b }; this.emit("resize"); }
    unmaximize() { this.calls.push("unmaximize"); }
    maximize() { this.max = true; this.b = { x: 0, y: 0, width: 1280, height: 778 }; this.emit("resize"); }
    setAlwaysOnTop(v) { this.top = v; this.emit("always-on-top-changed", {}, v); }
  }
  const TARGET = { x: 740, y: 52, width: 520, height: 720 };
  // Upstream's dock (ZWo/QWo/JWo, 5.1231.2) in short: unmaximize, animate
  // setBounds to the panel (its last frame is exactly the target), then
  // setAlwaysOnTop(true). GNOME's restore of the pre-maximize size lands
  // `lateMs` after the dock signal (late) or before the animation (normal).
  async function upstreamDock(w, lateMs) {
    const wasMax = w.isMaximized();
    if (wasMax) w.unmaximize();
    const restore = () => { w.max = false; w.b = { x: 97, y: 11, width: 1085, height: 778 }; w.emit("unmaximize"); w.emit("resize"); };
    if (wasMax && lateMs === null) restore();
    const r = w.getBounds();
    for (const c of [0.1, 0.5, 0.9, 1]) { await sleep(5); w.setBounds({ x: Math.round(r.x + (TARGET.x - r.x) * c), y: Math.round(r.y + (TARGET.y - r.y) * c), width: Math.round(r.width + (TARGET.width - r.width) * c), height: Math.round(r.height + (TARGET.height - r.height) * c) }); }
    w.setAlwaysOnTop(true);
    if (wasMax && typeof lateMs === "number") setTimeout(restore, lateMs);
  }
  const dockLines = (rig) => rig.log.filter((l) => l.includes("[claude-cu] dock:"));
  // Let the earlier cases' async lock hooks settle: they reach whichever
  // executor is globalThis.__linuxExecutor by then.
  await sleep(500);
  const rigFor = () => { const rig = makeRig(5, (sub) => (sub === "screens" ? screensJson([true]) : "{}"), EDISPLAYS); return rig; };

  // (a) the miss: GNOME's unmaximize restore lands 60 ms after the dock signal.
  {
    const w = new Win({ x: 0, y: 0, width: 1280, height: 778 }); w.max = true; rigWindows.list = [w];
    const rig = rigFor();
    const p = rig.ex.__setLockHeld(true, "local_a");
    await upstreamDock(w, 60);
    await sleep(150);
    ok(w.b.width === 520 && w.b.height === 720 && !w.max, "late restore: the window is back at upstream's 520x720", w.b.width + "x" + w.b.height + " " + w.calls.slice(-2).join(","));
    ok(dockLines(rig).length === 1 && /is 1085x778 after the dock, not the 520x720 upstream asked for \(late (resize|unmaximize)\) - asking once more/.test(dockLines(rig)[0]), "one line names the miss", dockLines(rig).join(" | "));
    ok(!Object.prototype.hasOwnProperty.call(w, "setBounds"), "upstream's setBounds is no longer wrapped after the dock signal");
    await sleep(1500);
    ok(dockLines(rig).some((l) => l.includes("the docked size holds after asking once more")), "the check confirms the dock held", dockLines(rig).join(" | "));
    rig.ex.__setLockHeld(false); await p; rig.restore();
  }
  // (b) a dock that lands: nothing is asked again, nothing logged.
  {
    const w = new Win({ x: 0, y: 0, width: 1280, height: 778 }); w.max = true; rigWindows.list = [w];
    const rig = rigFor();
    rig.ex.__setLockHeld(true, "local_b");
    await upstreamDock(w, null);
    const n = w.calls.length;
    await sleep(1600);
    ok(w.calls.length === n && dockLines(rig).length === 0 && w.b.width === 520, "a dock that landed: no second setBounds, no line", w.calls.slice(n).join(",") + " " + dockLines(rig).join(" | "));
    rig.ex.__setLockHeld(false); rig.restore();
  }
  // (c) asked once only: a window manager that keeps the window large gets one
  // more request, then one line that Claude's window may cover the screen.
  {
    const w = new Win({ x: 0, y: 0, width: 1280, height: 778 }); w.max = true; rigWindows.list = [w];
    const rig = rigFor();
    rig.ex.__setLockHeld(true, "local_c");
    await upstreamDock(w, 30);
    await sleep(60);
    // The window manager puts its size back after every request from now on.
    w.on("resize", () => { if (w.b.width !== 1085) setTimeout(() => { w.b = { x: 97, y: 11, width: 1085, height: 778 }; w.emit("resize"); }, 5); });
    w.emit("resize");
    await sleep(1600);
    const again = w.calls.filter((c) => c === "setBounds 520x720").length;
    ok(again === 2 && dockLines(rig).filter((l) => l.includes("asking once more")).length === 1 && dockLines(rig).some((l) => l.includes("stayed 1085x778, not the docked 520x720 - it may cover part of the screen")), "asked once more only, then the miss is logged", again + " | " + dockLines(rig).join(" | "));
    rig.ex.__setLockHeld(false); rig.restore();
  }
  // (f) GNOME still reports the maximized size at the dock signal (the
  // animation's frames were not applied yet); its late restore follows. That
  // late event owns the one re-assert: the dock lands.
  {
    const w = new Win({ x: 0, y: 0, width: 1280, height: 778 }); w.max = true; w.frozen = true; rigWindows.list = [w];
    const rig = rigFor();
    rig.ex.__setLockHeld(true, "local_f");
    await upstreamDock(w, false);
    const atSignal = w.b.width + "x" + w.b.height;
    w.emit("resize");                                   // a configure that keeps the maximized size: no news
    await sleep(60);
    w.frozen = false; w.max = false; w.b = { x: 97, y: 11, width: 1085, height: 778 }; w.emit("unmaximize"); w.emit("resize");
    await sleep(100);
    ok(atSignal === "1280x778" && w.b.width === 520 && w.b.height === 720, "maximized size at the signal, late restore after: the late event re-asserts, the dock lands", atSignal + " -> " + w.b.width + "x" + w.b.height + " | " + dockLines(rig).join(" | "));
    ok(dockLines(rig).filter((l) => l.includes("asking once more")).length === 1 && dockLines(rig).some((l) => l.includes("(late unmaximize)")), "  asked once, by the late unmaximize", dockLines(rig).join(" | "));
    await sleep(1500);
    ok(dockLines(rig).some((l) => l.includes("the docked size holds")), "  and the dock holds", dockLines(rig).join(" | "));
    rig.ex.__setLockHeld(false); rig.restore();
  }
  // (g) maximized size at the signal and no late event at all: asked once
  // after the settle delay, so a stuck window is still corrected.
  {
    const w = new Win({ x: 0, y: 0, width: 1280, height: 778 }); w.max = true; w.frozen = true; rigWindows.list = [w];
    const rig = rigFor();
    rig.ex.__setLockHeld(true, "local_g");
    await upstreamDock(w, false);
    w.frozen = false;
    await sleep(600);
    ok(w.b.width === 520 && dockLines(rig).some((l) => l.includes("still off 400 ms after the dock signal")), "no late event: asked once after 400 ms", w.b.width + "x" + w.b.height + " | " + dockLines(rig).join(" | "));
    rig.ex.__setLockHeld(false); rig.restore();
  }
  // (d) the lock is released before the dock signal: nothing stays wrapped,
  // upstream's restore is not touched.
  {
    const w = new Win({ x: 0, y: 0, width: 1280, height: 778 }); w.max = true; rigWindows.list = [w];
    const rig = rigFor();
    rig.ex.__setLockHeld(true, "local_d");
    ok(Object.prototype.hasOwnProperty.call(w, "setBounds"), "while the dock runs, upstream's setBounds calls are recorded on the window");
    rig.ex.__setLockHeld(false);
    ok(!Object.prototype.hasOwnProperty.call(w, "setBounds") && w.listenerCount("always-on-top-changed") === 0 && w.listenerCount("resize") === 0, "a release removes the wrapper and every listener");
    rig.restore();
  }
  // (e) kwin mode (its own executor docks) and an already docked window: untouched.
  {
    const w = new Win({ x: 0, y: 0, width: 1280, height: 778 }); rigWindows.list = [w];
    const rig = rigFor();
    globalThis.__cuKwinMode = true;
    rig.ex.__setLockHeld(true, "local_e");
    ok(!Object.prototype.hasOwnProperty.call(w, "setBounds") && w.listenerCount("always-on-top-changed") === 0, "kwin mode: no dock check");
    globalThis.__cuKwinMode = false;
    rig.ex.__setLockHeld(false);
    w.top = true;
    rig.ex.__setLockHeld(true, "local_e2");
    ok(!Object.prototype.hasOwnProperty.call(w, "setBounds"), "already always on top (docked): no dock check");
    rig.ex.__setLockHeld(false); rig.restore();
  }
  rigWindows.list = [];
}

console.log("\n" + (fail ? `${pass} passed, ${fail} FAILED` : `ALL ${pass} CHECKS PASSED`));
process.exit(fail ? 1 : 0);
