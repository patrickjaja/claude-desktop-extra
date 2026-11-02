// Cloud-session check for the Wayland portal session (issue #293).
// Injected by fix_computer_use_linux.nim (Patch 1) before both executors at
// app ready, Linux only. Plain script: no import/export.
//
// A cloud Cowork task gives main no task-end signal, and upstream keeps the CU
// lock up to 12 min after the turn, so the portal session (and the desktop's
// "screen is being shared" indicator) outlived the task until the 2 min idle
// end. While a portal session is up for a cloud lock holder (session_X /
// cse_X), this polls upstream's own session-state check (exposed by sub-patch
// 4f as globalThis.__cdbRemoteSessionMode, Electron net + the app's cookies)
// 10 s after the last Computer Use action and every 10 s after that. When the
// session has ended, it hands over to the executor's task boundary, which ends
// the portal session and lifts a stop-sharing latch. The idle timer stays as
// the backstop: errors (thrown, transient, any other ok:false - upstream caches
// those 30 s) back off 20/40/60 s and never end anything; a session the server
// does not know (notFound) is not checked again until the lock is released or
// taken again.
//
// arm(holder, hooks): (re)schedule; no-op for a non-cloud or missing holder.
//   hooks.busy()    truthy -> skip this check (command/start/end in flight, held
//                   button); asked again when the reply lands, before ending
//   hooks.active()  falsy -> no portal session and no stop latch: stop checking
//   hooks.onEnded() called once when the session ended (the executor's
//                   __cuTaskBoundary(holder, "session-check", holder))
//   hooks.log(msg)  optional, default globalThis.__cdbDiag
// touch(): a tool call is starting: a reply already in flight is dropped and
//   the next check is 10 s (or the backed-off interval) away.
// stop(reason): cancel; one log line only when a check was armed.
// forget(): lock released or taken: a notFound holder is checked again.
// _seam({setTimeout, clearTimeout, now}): test seam, also resets all state.
(function () {
  if (globalThis.__cdbCuSessionCheck) return;
  var CU_SESSION_CHECK_MS = 10000, CU_SESSION_CHECK_MAX_MS = 60000;
  var T = { setTimeout: setTimeout, clearTimeout: clearTimeout, now: Date.now };
  // holder: the armed cloud holder (null = idle). seq: bumped by every arm and
  // stop and touch, so a reply that lands after either is dropped (a new action
  // means a new turn may be running: the next check asks again). dead: a holder
  // the server does not know; not polled again until forget() (lock released or
  // taken).
  var S;
  function reset() { S = { holder: null, hooks: null, timer: null, interval: CU_SESSION_CHECK_MS, seq: 0, inFlight: false, dead: null, armedAt: 0 }; }
  reset();
  function isCloud(h) { return typeof h === "string" && /^(session_|cse_)/i.test(h); }
  function requestId(h) { return h.replace(/^session_/i, "cse_"); }
  function log(m) {
    var f = S.hooks && typeof S.hooks.log === "function" ? S.hooks.log : globalThis.__cdbDiag;
    try { if (typeof f === "function") f(m); } catch (e) {}
  }
  function clear() { if (S.timer) { try { T.clearTimeout(S.timer); } catch (e) {} S.timer = null; } }
  function schedule(ms) {
    clear();
    S.timer = T.setTimeout(fire, ms);
    if (S.timer && typeof S.timer.unref === "function") S.timer.unref();
  }
  function call(hooks, name) {
    try { return !!(hooks && typeof hooks[name] === "function" && hooks[name]()); } catch (e) { return false; }
  }
  function idle() { S.holder = null; S.hooks = null; S.seq++; S.inFlight = false; S.interval = CU_SESSION_CHECK_MS; clear(); }
  function stopNow(reason) {
    var was = S.holder;
    clear();
    if (!was) return;
    log("[claude-cu] session check: stopped for " + was + " (" + (reason || "stopped") + ")");
    idle();
  }
  function inactive(hooks) { return !!(hooks && typeof hooks.active === "function" && !call(hooks, "active")); }
  function backOff(why) {
    var next = Math.min(S.interval * 2, CU_SESSION_CHECK_MAX_MS);
    if (next !== S.interval) {
      S.interval = next;
      log("[claude-cu] session check: " + why + ", backing off to " + Math.round(next / 1000) + " s");
    }
  }
  async function fire() {
    S.timer = null;
    var holder = S.holder, hooks = S.hooks, seq = S.seq;
    if (!holder) return;
    if (inactive(hooks)) { stopNow("no portal session"); return; }
    if (call(hooks, "busy")) { schedule(S.interval); return; }
    var r, err = null;
    S.inFlight = true;
    try {
      var m = await (globalThis.__cdbRemoteSessionMode && globalThis.__cdbRemoteSessionMode());
      if (!m || typeof m.refresh !== "function") throw new Error("no session-state check");
      r = await m.refresh(requestId(holder));
    } catch (e) { err = e; }
    if (seq === S.seq) S.inFlight = false;
    // Stopped, re-armed or re-held while the request ran: this reply is stale.
    if (seq !== S.seq || S.holder !== holder) return;
    if (err || !r || typeof r !== "object") {
      backOff("the session state is unavailable (" + (err ? (err.message || String(err)) : "no result") + ")");
      schedule(S.interval);
      return;
    }
    if (r.ended === true) {
      // The session may have gone, or a tool call begun, while the request ran.
      if (inactive(hooks)) { stopNow("no portal session"); return; }
      if (call(hooks, "busy")) { schedule(S.interval); return; }
      log("[claude-cu] session check: " + holder + " ended, ending the portal session");
      idle();
      try { if (hooks && typeof hooks.onEnded === "function") await hooks.onEnded(); }
      catch (e) { log("[claude-cu] session check: ending the portal session failed: " + (e && e.message || e)); }
      return;
    }
    if (r.notFound) {
      log("[claude-cu] session check: " + holder + " is not known to the server, stopping the check until the lock is released (the idle timer still ends the portal session)");
      idle(); S.dead = holder;
      return;
    }
    if (r.ok === false) {
      backOff("the session state is unavailable (" + (r.transient ? "transient" : "request failed") + ")");
      schedule(S.interval);
      return;
    }
    if (S.interval !== CU_SESSION_CHECK_MS) {
      S.interval = CU_SESSION_CHECK_MS;
      log("[claude-cu] session check: the session state is available again, checking every " + (CU_SESSION_CHECK_MS / 1000) + " s");
    }
    schedule(S.interval);
  }
  globalThis.__cdbCuSessionCheck = {
    CU_SESSION_CHECK_MS: CU_SESSION_CHECK_MS,
    arm: function (holder, hooks) {
      if (!isCloud(holder)) return;
      // No session-state check exposed (an older patch set): never armed.
      if (typeof globalThis.__cdbRemoteSessionMode !== "function") return;
      if (S.dead !== null && S.dead === holder) return;
      if (S.holder !== holder) S.interval = CU_SESSION_CHECK_MS;
      S.holder = holder; S.hooks = hooks || null; S.seq++; S.inFlight = false;
      S.armedAt = T.now();
      schedule(S.interval);
    },
    touch: function () {
      if (!S.holder) return;
      S.seq++; S.inFlight = false;
      schedule(S.interval);
    },
    stop: function (reason) { stopNow(reason); },
    forget: function () { S.dead = null; },
    _state: function () { return { holder: S.holder, armed: !!S.timer, interval: S.interval, inFlight: S.inFlight, dead: S.dead, armedAt: S.armedAt }; },
    _seam: function (o) {
      clear();
      o = o || {};
      T = { setTimeout: o.setTimeout || setTimeout, clearTimeout: o.clearTimeout || clearTimeout, now: o.now || Date.now };
      reset();
    }
  };
})();
