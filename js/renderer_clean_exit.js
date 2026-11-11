/* Main-view renderer recovery helpers (issues #287 and #299).
 *
 * fix_renderer_clean_exit_reload.nim inlines this expression once, as a
 * statement in front of upstream's main-webview reason filter, in the chunk
 * that holds the filter, the unresponsive watchdog and the render-process-gone
 * handler. It installs two globals; each is defined with ||= so a second
 * evaluation keeps the first instance (and its state).
 *
 * Upstream's reason filter (v5.1231.0 names Ltr / Mtr / eI, re-minified every
 * release) first asks Mtr(), which takes one "we crashed it ourselves" token;
 * with a token its verdict is own kill, without one a clean-exit and a
 * `killed` while quitting are teardown, everything else needs recovery. The
 * unresponsive watchdog adds a token each time it starts a kill attempt on the
 * main view; the token expires 10 s after the attempt, or 5 min later while
 * upstream's recovery reload is pending. The watchdog reloads the view 1 s
 * after its crash request when no death was reported, and again when the
 * own-kill death arrives later; a 30 s re-check reloads once more when no page
 * committed (at most 3 times per 5 min, then its error card). eI() is
 * upstream's own quitting predicate.
 * (Spelled out in words on purpose: this comment is inlined into the bundle
 * and must not match the patch's own anchors.)
 *
 * 1. __cdbCleanExitRecoverable(details, isQuitting)       (#287, sub-patch A)
 *    Asked in the filter's clean-exit term. On Linux the main view's renderer
 *    can exit with reason clean-exit / exitCode 0 on its own; upstream drops
 *    that unconditionally and the window stays blank. Returns true only for a
 *    clean-exit on Linux while the app is not quitting, at most 3 times per
 *    10 minutes (a renderer that exits cleanly in a loop falls back to
 *    upstream behavior: suppressed, no reload spin). The timestamps live in
 *    globalThis.__cdbCleanExitReloads so DevTools can inspect or reset them.
 *
 * 2. __cdbHungKillEscalate(webContents)                   (#299, sub-patch D)
 *    Called right before upstream's crash request, after upstream's own spare
 *    check decided to kill. On Linux Electron sends that request to the
 *    renderer, which crashes itself on its IO thread: that works while only
 *    the renderer's main thread is hung, and does nothing when the whole
 *    renderer process is stalled (IO thread blocked too). This helper records
 *    the renderer pid; after 5 s, if the WebContents is neither destroyed nor
 *    crashed, still has the same renderer pid and no `responsive` event
 *    arrived since, it asks the main frame to evaluate `1` (a liveness probe,
 *    2 s timeout). Electron's `responsive` can lag well behind a renderer that
 *    resumed, so a probe that answers cancels the kill. Only when it times out
 *    or rejects, and the guards above still hold, the renderer gets SIGKILL
 *    (about 7 s after the crash request at most). Electron then reports it
 *    gone (reason killed); the attempt's token is still pending, so upstream's
 *    filter calls it an own kill and the watchdog's post-kill reload loads
 *    the view into a new renderer. One `responsive` listener per
 *    WebContents (WeakSet) cancels a pending kill, and one probe at most is in
 *    flight per WebContents. Never throws.
 *
 * Both are Linux only (process.platform), with no session, compositor or
 * GPU gating. One [cdb-renderer] line per decision goes to claude-patches.log
 * via __cdbDiag.
 * Comments are block comments only: the expression is inlined into a minified
 * line, where a // comment would swallow the code after it.
 */
(function () {
  /*__cdb_clean_exit_reload_v3__*/
  var MAX_RELOADS = 3;
  var WINDOW_MS = 10 * 60 * 1000;
  var ESCALATE_MS = 5000;
  function log(msg) {
    try {
      (globalThis.__cdbDiag || console.log)("[cdb-renderer] " + msg);
    } catch (_) {}
  }
  function quittingNow(isQuitting) {
    try {
      return typeof isQuitting === "function" && !!isQuitting();
    } catch (_) {
      return false;
    }
  }

  globalThis.__cdbCleanExitRecoverable ||= function (details, isQuitting) {
    if (!details || details.reason !== "clean-exit") return false;
    if (process.platform !== "linux") return false;
    var tag = "main view clean-exit (exitCode " + details.exitCode + ")";
    if (quittingNow(isQuitting)) {
      log(tag + ": app is quitting, leaving it suppressed");
      return false;
    }
    var reloads = (globalThis.__cdbCleanExitReloads = globalThis.__cdbCleanExitReloads || []);
    var now = Date.now();
    while (reloads.length && now - reloads[0] > WINDOW_MS) reloads.shift();
    if (reloads.length >= MAX_RELOADS) {
      log(
        tag + ": " + reloads.length + " reloads in the last " + WINDOW_MS / 60000 +
          " min, leaving it suppressed (upstream behavior)"
      );
      return false;
    }
    reloads.push(now);
    log(
      tag + ": not app-initiated, handing it to the reload path (" + reloads.length + "/" +
        MAX_RELOADS + " in " + WINDOW_MS / 60000 + " min)"
    );
    return true;
  };

  var PROBE_MS = 2000;
  function errText(e) {
    return e && e.message ? e.message : String(e);
  }
  /* Active liveness check: ask the main frame to evaluate `1`. A renderer that
   * resumed answers within milliseconds even when Electron's hang monitor has
   * not reported `responsive` yet; a hung one never answers. WebFrameMain's
   * executeJavaScript is used because WebContents.executeJavaScript waits for
   * a pending load to finish first (upstream queues a reload right after its
   * crash request). userGesture is false so an answering page gets no
 * transient user activation. Resolves {ok} or {ok:false, why}; never rejects. */
  function probe(wc) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ ok: false, why: "no answer in " + PROBE_MS / 1000 + " s" });
      }, PROBE_MS);
      if (t && typeof t.unref === "function") t.unref();
      var p;
      try {
        var f = wc.mainFrame;
        p =
          f && typeof f.executeJavaScript === "function"
            ? f.executeJavaScript("1", false)
            : wc.executeJavaScript("1", false);
      } catch (e) {
        p = Promise.reject(e);
      }
      Promise.resolve(p).then(
        function () {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve({ ok: true });
        },
        function (e) {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve({ ok: false, why: "probe rejected: " + errText(e) });
        }
      );
    });
  }

  var listening = new WeakSet();
  var pending = new WeakMap();
  globalThis.__cdbHungKillEscalate ||= function (wc) {
    try {
      if (process.platform !== "linux" || !wc || wc.isDestroyed()) return;
      var pid = wc.getOSProcessId();
      if (!(pid > 0)) {
        log("hung main view: no renderer pid, not arming the SIGKILL fallback");
        return;
      }
      if (!listening.has(wc)) {
        listening.add(wc);
        wc.on("responsive", function () {
          var st = pending.get(wc);
          if (!st || st.responsive) return;
          st.responsive = true;
          clearTimeout(st.timer);
          /* A probe in flight keeps the slot until it settles (one per view). */
          if (!st.probing) pending.delete(wc);
          var now;
          try {
            now = wc.getOSProcessId();
          } catch (_) {}
          log(
            (now === st.pid
              ? "main view renderer " + st.pid + " is responsive again"
              : now > 0
                ? "main view is responsive on a new renderer (" + st.pid + " -> " + now + ")"
                : "main view renderer " + st.pid + " is gone (hang monitor reset)") +
              ", SIGKILL fallback cancelled"
          );
        });
      }
      var cur = pending.get(wc);
      if (cur && (cur.pid === pid || cur.probing)) return; /* keep the first deadline / one probe */
      if (cur) clearTimeout(cur.timer);
      var st = { pid: pid, responsive: false, probing: false, timer: null };
      /* null when the kill is still warranted, else why it is not */
      var blocker = function () {
        if (st.responsive) return "";
        if (wc.isDestroyed()) return "main view destroyed before the SIGKILL fallback, skipping";
        if (wc.isCrashed())
          return "main view renderer " + pid + " already gone, SIGKILL fallback not needed";
        var now = wc.getOSProcessId();
        if (now !== pid)
          return "main view renderer changed (" + pid + " -> " + now + "), SIGKILL fallback skipped";
        return null;
      };
      var release = function () {
        if (pending.get(wc) === st) pending.delete(wc);
      };
      st.timer = setTimeout(function () {
        try {
          var b = blocker();
          if (b !== null) {
            release();
            if (b) log(b);
            return;
          }
          st.probing = true;
          probe(wc).then(function (r) {
            try {
              st.probing = false;
              release();
              if (r.ok) {
                if (!st.responsive)
                  log(
                    "main view renderer " + pid + " answered a liveness probe " +
                      ESCALATE_MS / 1000 + " s after forcefullyCrashRenderer(), SIGKILL cancelled"
                  );
                return;
              }
              var b2 = blocker();
              if (b2 !== null) {
                if (b2) log(b2);
                return;
              }
              log(
                "main view renderer " + pid + " still hung after forcefullyCrashRenderer() (" +
                  ESCALATE_MS / 1000 + " s, then liveness probe: " + r.why +
                  "), escalating to SIGKILL"
              );
              process.kill(pid, "SIGKILL");
            } catch (e) {
              log("SIGKILL fallback failed: " + errText(e));
            }
          });
        } catch (e) {
          release();
          log("SIGKILL fallback failed: " + errText(e));
        }
      }, ESCALATE_MS);
      if (st.timer && typeof st.timer.unref === "function") st.timer.unref();
      pending.set(wc, st);
      log(
        "main view renderer " + pid + " hung, forcefullyCrashRenderer() requested; SIGKILL in " +
          ESCALATE_MS / 1000 + " s unless it recovers (then a " + PROBE_MS / 1000 +
          " s liveness probe)"
      );
    } catch (e) {
      log("SIGKILL fallback not armed: " + errText(e));
    }
  };
})()
