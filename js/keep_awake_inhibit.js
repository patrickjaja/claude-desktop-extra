/* __cdb_keep_awake_inhibit_v1__
   logind sleep inhibitor for upstream's "Keep computer awake".

   Injected by patches/linux/fix_keep_awake_linux.nim, which wraps upstream's
   single keep-awake blocker start and stop calls: start() receives and returns
   upstream's blocker id unchanged, stop() runs right before upstream's stop.

   Why: on Linux, Chromium's "prevent-app-suspension" blocker only calls
   org.gnome.SessionManager.Inhibit, falling back to
   org.freedesktop.PowerManagement.Inhibit, and silently does nothing when
   neither name has an owner on the session bus. It never talks to logind.
   GNOME (gnome-session), KDE (PowerDevil) and XFCE (xfce4-power-manager) own
   one of those names; Sway, Hyprland, niri, river, i3 and similar setups
   usually own neither, so the machine still idle-suspends with keep-awake on.

   What: when neither name has an owner, hold
       systemd-inhibit --what=sleep --who=Claude --why=... --mode=block cat
   for as long as upstream's blocker is active. Where a native service exists,
   nothing is added, so upstream's behavior there is unchanged.

   Leak-proofing: the inhibitor's command is `cat` reading a pipe from this
   process. Any exit of the app - stop(), quit, crash, SIGKILL - closes the
   pipe, `cat` sees EOF, systemd-inhibit exits and logind drops the lock.
   stop() and the quit hooks also kill it explicitly.

   Diagnostics go to __cdbDiag (claude-patches.log); console output is discarded
   by the official build. */
(function () {
  if (globalThis.__cdbKeepAwake) return;
  var diag = function (m) {
    try {
      (globalThis.__cdbDiag || console.log)("[keep-awake-linux] " + m);
    } catch (e) {}
  };
  var NATIVE = ["org.gnome.SessionManager", "org.freedesktop.PowerManagement"];
  var wanted = false;
  var gen = 0;
  var child = null;
  var hooked = false;
  var probes = 0;

  function which(name) {
    try {
      var fs = require("fs"),
        path = require("path");
      var dirs = (process.env.PATH || "").split(":");
      for (var i = 0; i < dirs.length; i++) {
        if (!dirs[i] || dirs[i].charAt(0) !== "/") continue;
        var p = path.join(dirs[i], name);
        try {
          fs.accessSync(p, fs.constants.X_OK);
          if (fs.statSync(p).isFile()) return p;
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  function hasOwner(busctl, name) {
    return new Promise(function (resolve) {
      try {
        require("child_process").execFile(
          busctl,
          ["--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "NameHasOwner", "s", name],
          { timeout: 2000 },
          function (err, stdout) {
            resolve(!err && /^b true/.test(String(stdout).trim()));
          }
        );
      } catch (e) {
        resolve(false);
      }
    });
  }

  // Resolves to the first native inhibit service that has an owner, or null.
  // No busctl means we cannot tell; fall through to holding our own lock,
  // since the user asked for the machine to stay awake.
  function nativeService() {
    var busctl = which("busctl");
    if (!busctl) return Promise.resolve(null);
    return Promise.all(NATIVE.map(function (n) { return hasOwner(busctl, n); }))
      .then(function (r) {
        for (var i = 0; i < r.length; i++) if (r[i]) return NATIVE[i];
        return null;
      });
  }

  function killChild(why) {
    var c = child;
    child = null;
    if (!c) return;
    try { c.stdin && c.stdin.destroy(); } catch (e) {}
    try { c.kill("SIGTERM"); } catch (e) {}
    diag("inhibitor released (" + why + ", pid=" + c.pid + ")");
  }

  function hookQuit() {
    if (hooked) return;
    hooked = true;
    var onQuit = function () {
      wanted = false;
      gen++;
      killChild("quit");
    };
    // Not before-quit: that fires for quits that are later vetoed (close to
    // tray, confirm dialogs), which would drop the lock while the app runs on.
    try { process.on("exit", onQuit); } catch (e) {}
    try { require("electron").app.on("will-quit", onQuit); } catch (e) {}
  }

  function spawnInhibitor(bin) {
    var c;
    try {
      c = require("child_process").spawn(
        bin,
        ["--what=sleep", "--who=Claude",
          "--why=Keep computer awake is on", "--mode=block", "cat"],
        { stdio: ["pipe", "ignore", "ignore"], detached: false }
      );
    } catch (e) {
      diag("spawn failed: " + (e && e.message));
      return;
    }
    child = c;
    c.on("error", function (e) {
      diag("inhibitor error: " + (e && e.message));
      if (child === c) child = null;
    });
    c.on("exit", function (code, sig) {
      if (child === c) {
        child = null;
        diag("inhibitor exited unexpectedly (code=" + code + ", signal=" + sig + ")");
      }
    });
    try { c.stdin.on("error", function () {}); } catch (e) {}
    diag("inhibitor held via " + bin + " (pid=" + c.pid + ")");
  }

  globalThis.__cdbKeepAwake = {
    // Pass-through: returns upstream's blocker id unchanged.
    start: function (id) {
      try {
        if (process.platform !== "linux" || wanted) return id;
        wanted = true;
        var g = ++gen;
        hookQuit();
        var bin = which("systemd-inhibit");
        if (!bin) {
          diag("systemd-inhibit not on PATH; relying on powerSaveBlocker only");
          return id;
        }
        nativeService().then(function (svc) {
          probes++;
          if (g !== gen || !wanted || child) return;
          if (svc) {
            diag("native inhibit service " + svc + " present; powerSaveBlocker covers it");
            return;
          }
          spawnInhibitor(bin);
        }, function () {});
      } catch (e) {
        diag("start failed: " + (e && e.message));
      }
      return id;
    },
    stop: function () {
      try {
        wanted = false;
        gen++;
        killChild("stop");
      } catch (e) {}
    },
    // For the test harness only.
    _state: function () {
      return { wanted: wanted, pid: child ? child.pid : null, probes: probes };
    },
  };
})();
