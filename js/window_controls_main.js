/*
 * window_controls_main.js - IPC half of the two titlebar-mode opt-ins.
 *
 * Reads and writes `nativeTitlebar` and `noWindowControls` in
 * <userData>/claude-desktop-extra.json for the two Settings -> Extra ->
 * Community Features rows:
 *
 *   cdb-wc:native-read / cdb-wc:native-set   -> nativeTitlebar
 *   cdb-wc:pref-read   / cdb-wc:pref-set     -> noWindowControls
 *
 * All the file knowledge lives in js/window_controls_pref.js (injected
 * immediately before this file by the same patch) and is reached through
 * globalThis.__cdbWinCtlPref, so the readers the window uses at construction
 * time and the writers the toggles use can never disagree about the keys, the
 * files or the lock rule. Both handler pairs are built from the same factory
 * for the same reason.
 *
 * Unlike the other feature toggles these CANNOT apply live: frame,
 * titleBarStyle and hasShadow are BrowserWindow constructor options on Linux
 * (setTitleBarOverlay(false) throws, there is no setFrame), so the rows' copy
 * tells the user to restart. Nothing here touches an open window, and nothing
 * here ranks the two modes against each other - that resolution belongs to
 * patches/linux/fix_native_frame.nim, which reads the two globals.
 *
 * SECURITY: the caller is remote claude.ai code. Every handler validates the
 * sender's ORIGIN (not a substring test of the URL - see okSender below) and
 * takes only a boolean; nothing page-supplied reaches the filesystem. In
 * particular the config KEY is never taken from the caller - each channel is
 * bound to one fixed key at registration time.
 */
;/*__CDB_WINCTL_MAIN__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbWinCtlMain) return;
  globalThis.__cdbWinCtlMain = true;

  var _electron = require("electron");
  var _ipc = _electron.ipcMain;
  var _fs = require("fs");
  var _URL = require("url").URL;

  function log(m) { (globalThis.__cdbDiag || console.log)("[window-controls] " + m); }

  // The reader half is prepended by the same patch, in the same injection
  // string, so it is always evaluated first. Bailing out loudly instead of
  // re-implementing the file logic keeps a single source of truth.
  var PREF = globalThis.__cdbWinCtlPref;
  if (!PREF) {
    log("window_controls_pref.js missing - no IPC registered");
    return;
  }
  var PREF_DEFAULT = PREF.PREF_DEFAULT;
  var JSON_NAME = PREF.JSON_NAME;
  var JSONC_NAME = PREF.JSONC_NAME;

  // Writes ONLY the .json (the .jsonc is never created or rewritten here), tmp +
  // rename so a crash cannot leave half a file, and every other key survives -
  // including the OTHER mode's key, which is why this reads-modifies-writes
  // instead of replacing the file.
  //
  // Unlike PREF.readFileJson, an existing-but-broken file is NOT silently
  // treated as empty here: that would make a pref-set report success while
  // quietly discarding every other extra's settings the moment a user's
  // hand-edited file has a stray comma or an unbalanced brace. ENOENT (file
  // genuinely absent) is the only case that proceeds with an empty object;
  // every other read/parse/shape failure refuses and writes nothing.
  function writePref(key, value) {
    var p = PREF.pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try { raw = _fs.readFileSync(p, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || String(e)) };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = PREF.stripComments(raw);
      try { cfg = stripped.trim() ? JSON.parse(stripped) : {}; }
      catch (e2) {
        return { ok: false, error: p + " is not valid JSON (" + e2.message +
          ") - fix or remove it first; nothing was written" };
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      }
      if (stripped !== raw) {
        // Rewriting as plain JSON drops comments - keep the original once.
        try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }
    // The default is FALSE, so "off" is the ABSENCE of the key: a fresh install
    // and one that switched the feature back off look the same on disk, and only
    // an explicit opt-in ever writes anything.
    if (value === PREF_DEFAULT) delete cfg[key];
    else cfg[key] = value;
    var tmp = p + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p + ": " + ((e4 && e4.message) || String(e4)) };
    }
    return { ok: true, path: p };
  }

  // Exact-origin allowlist, same posture as the panel-tabs, diff-views and
  // cowork-glow sender checks: comparing parsed origins instead of testing
  // whether the raw URL STRING contains "claude.ai"/"claude.com" anywhere. A
  // substring test would also pass a lookalike host such as
  // "https://evil.example/?next=claude.ai" or "https://claude.ai.evil.example"
  // - both contain the substring, neither is our origin.
  var ALLOWED_ORIGINS = [
    "https://claude.ai",
    "https://preview.claude.ai",
    "https://claude.com",
    "https://preview.claude.com"
  ];
  function originAllowed(rawUrl) {
    var origin;
    try { origin = new _URL(String(rawUrl)).origin; } catch (e) { return false; }
    for (var i = 0; i < ALLOWED_ORIGINS.length; i++) {
      if (origin === ALLOWED_ORIGINS[i]) return true;
    }
    return false;
  }
  // FAILS CLOSED: wc.isDestroyed() is called unguarded, same as the panel-tabs
  // and diff-views precedents - a sender object missing the method throws, the
  // catch below turns that into "not ok", not "assume fine". Do not soften this
  // to a typeof-guard that treats a missing method as "not destroyed".
  function okSender(ev) {
    try {
      var wc = ev && ev.sender;
      if (!wc || wc.isDestroyed()) return false;
      if (!originAllowed(wc.getURL() || "")) return false;
      var frame = ev.senderFrame;
      if (frame && frame.parent) return false;
      return true;
    } catch (e) { return false; }
  }

  // One read/set pair per mode, both bound to a FIXED key here. The two modes
  // are independent as far as this layer is concerned: setting one never
  // touches the other's key, and neither read reports anything about the other.
  function registerPair(readChannel, setChannel, mode) {
    // Reports the SAVED and the RUNNING value separately, because these two
    // modes are the only settings here that cannot apply live:
    //   enabled - what the config files hold, fresh read, env var NOT ORed in
    //             (see savedFor: ORing would render the switch ON when nothing
    //             is saved and a launcher flag is doing the work)
    //   active  - the memoized value the running window was built with, or
    //             null when nothing has asked yet, so there is no running
    //             value to compare against
    // The row shows a restart notice exactly while the two disagree - so it
    // stays silent for a user who never touches the setting, for one who
    // toggles it and restarts, and for one who toggles it and back again.
    _ipc.handle(readChannel, function (ev) {
      if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
      var saved = PREF.savedFor(mode);
      // envForced is ADDITIVE to the agreed shape: a launcher flag run makes
      // the window use the mode without touching the config, and the row can
      // say so instead of offering a switch that cannot win against it.
      return { ok: true, enabled: saved.value, active: PREF.activeFor(mode),
        lockedByJsonc: saved.source === "jsonc-locked", source: saved.source,
        envForced: saved.envForced };
    });

    _ipc.handle(setChannel, function (ev, enabled) {
      if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
      if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      var disk = PREF.readPrefFromDisk(mode.key);
      if (disk.source === "jsonc-locked") {
        return { ok: false, error: mode.key + " is set in " + JSONC_NAME +
          " - edit that file to change it" };
      }
      var w = writePref(mode.key, enabled);
      if (!w.ok) return w;
      log("pref " + mode.key + " set to " + enabled + " (" + w.path + ") - takes effect on restart");
      return { ok: true, enabled: enabled, path: w.path };
    });
  }

  registerPair("cdb-wc:native-read", "cdb-wc:native-set", PREF.MODES.nativeTitlebar);
  registerPair("cdb-wc:pref-read", "cdb-wc:pref-set", PREF.MODES.noWindowControls);

  // Our IIFE runs before __cdbDiag exists (same-anchor injections stack, and
  // console.log is discarded by the official build), so a synchronous log
  // here would be silently lost. Deferring one tick lets all top-level bundle
  // code run first, by which point __cdbDiag is defined.
  setTimeout(function () {
    var parts = [];
    var names = ["nativeTitlebar", "noWindowControls"];
    for (var i = 0; i < names.length; i++) {
      var mode = PREF.MODES[names[i]];
      var saved = PREF.savedFor(mode);
      // activeFor reads the memo WITHOUT calling the mode function: at this
      // point the window may not have been built yet, and forcing the first
      // call here would fix the running value before the window patch asked.
      var running = PREF.activeFor(mode);
      parts.push(mode.key + "=" + saved.value + " (source: " + saved.source +
        (saved.envForced ? ", forced on by " + mode.env + "=1" : "") +
        ", running: " + (running === null ? "not asked yet" : running) + ")");
    }
    // Per-mode "requested", NOT the resolved mode: native beating bare is
    // decided in patches/linux/fix_native_frame.nim, not here.
    log("installed (main); " + parts.join("; "));
  }, 0);
})();
