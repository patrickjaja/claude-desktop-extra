/* __CDB_DEV_TOOLS_TOGGLE__
 * Main-process half of patches/community/add_feature_dev_tools_toggle.nim:
 * the Settings -> Extra -> Community Features switch "Developer tools".
 *
 * Upstream keeps its own opt-in for DevTools in <userData>/developer_settings.json
 * ({"allowDevTools": true}): Ctrl+Alt+I and the "Toggle Dev Tools" menu entry
 * only work with it set, and upstream re-reads the file on every shortcut
 * press, so the switch applies immediately for the shortcut; the menu entry
 * is decided once at startup. Upstream also requires the org workspace to
 * leave developer mode enabled and the app not to be in its restricted mode -
 * this switch cannot override either, it only writes upstream's file.
 *
 * Channels (invoked from the Extra page through window.cdbExtra, the same
 * cross-patch arrangement as allowNonAnthropicModelsRead/Set):
 *   cdb-dt:pref-read  -> { ok, enabled, source: "file"|"missing"|"invalid", path }
 *   cdb-dt:pref-set   <- boolean; rewrites only the allowDevTools key, keeps
 *                        every other key, replaces an unparsable file (which
 *                        would otherwise raise upstream's startup error dialog)
 */
(function () {
  if (globalThis.__cdbDevToolsToggle) return;
  globalThis.__cdbDevToolsToggle = true;

  var _fs = require("fs");
  var _path = require("path");
  var _electron = require("electron");
  var _ipc = _electron.ipcMain;

  var FILE_NAME = "developer_settings.json";
  var KEY = "allowDevTools";

  // __cdbDiag (claude-patches.log) only exists once upstream's "ready" handler
  // ran and the official build discards console.log, so lines are queued and
  // polled for up to 30 s (the same shape as allow_non_anthropic_models.js).
  var logQueue = [], tries = 0;
  function emitLog(line) {
    try { (globalThis.__cdbDiag || console.log)(line); } catch (e) {}
  }
  function flushLog(force) {
    if (!force && typeof globalThis.__cdbDiag !== "function") return false;
    var q = logQueue;
    logQueue = [];
    for (var i = 0; i < q.length; i++) emitLog(q[i]);
    return true;
  }
  function log(m) {
    logQueue.push("[cdb-devtools] " + m);
    flushLog(false);
  }
  function poll() {
    if (flushLog(false)) return;
    if (++tries < 60) setTimeout(poll, 500);
    else flushLog(true);
  }

  function filePath() {
    return _path.join(_electron.app.getPath("userData"), FILE_NAME);
  }
  // { obj, source } - obj is null when the file is missing or not a JSON object.
  function readFile() {
    var p = filePath();
    if (!_fs.existsSync(p)) return { obj: null, source: "missing", path: p };
    try {
      var v = JSON.parse(_fs.readFileSync(p, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) return { obj: v, source: "file", path: p };
    } catch (e) {}
    return { obj: null, source: "invalid", path: p };
  }
  function writeFile(obj) {
    var p = filePath();
    _fs.mkdirSync(_path.dirname(p), { recursive: true });
    var tmp = p + ".tmp-" + process.pid;
    _fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    _fs.renameSync(tmp, p);
    return p;
  }

  // The IPC sender validator is shared: js/sender_guard.js (issue #318). Looked up
  // at call time; a missing guard fails closed.
  function okSender(ev) { var g = globalThis.__cdbSenderGuard; return !!g && g.okSender(ev); }
  function handle(channel, fn) {
    try {
      _ipc.handle(channel, function (ev) {
        if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
        try {
          return fn.apply(null, Array.prototype.slice.call(arguments, 1));
        } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
      });
    } catch (e) { log("could not register " + channel + ": " + ((e && e.message) || e)); }
  }

  handle("cdb-dt:pref-read", function () {
    var f = readFile();
    return {
      ok: true,
      // Opt-in: only an explicit true is on, exactly like upstream's own check.
      enabled: !!(f.obj && f.obj[KEY] === true),
      source: f.source,
      key: KEY,
      path: f.path
    };
  });

  handle("cdb-dt:pref-set", function (enabled) {
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    var f = readFile();
    var obj = f.obj || {};
    obj[KEY] = enabled;
    var p = writeFile(obj);
    log(KEY + " set to " + enabled + " (" + p + ")" +
        (f.source === "invalid" ? " - replaced an unparsable file" : ""));
    return { ok: true, enabled: enabled, path: p, replacedInvalid: f.source === "invalid" };
  });

  log("installed - " + FILE_NAME + " switch registered");
  setTimeout(poll, 0);
})();
