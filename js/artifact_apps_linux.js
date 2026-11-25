(function () {
  "use strict";
  // Linux compatibility runtime for upstream "Install as app" (artifactApps).
  // Embedded into index.js by patches/linux/fix_artifact_apps_linux.nim.
  // Defines globalThis.__cdbArtifactApps with zero external npm dependencies.

  var MARKER = "__cdb_artifact_apps_linux_v1__";
  var ARG_PREFIX = "--artifact-app=";
  var ARG_RE = /^--artifact-app=([0-9a-f]{32})$/;
  var QUEUE_TTL_MS = 60000;
  var CACHE_TOOL_TIMEOUT_MS = 5000;
  var BASE_APP_ID = "com.anthropic.Claude";

  var launchQueue = [];
  var hooks = null;

  function diag(msg) {
    try {
      (globalThis.__cdbDiag || console.log)(msg);
    } catch (_) {}
  }

  function profileName(env) {
    var e = env || process.env;
    var p = e && e.CLAUDE_PROFILE;
    if (typeof p !== "string" || p === "" || p === "default") return null;
    return /^[A-Za-z0-9_-]+$/.test(p) ? p : null;
  }

  function parseInstallId(argv) {
    if (!Array.isArray(argv)) return undefined;
    var sep = argv.indexOf("--");
    var end = sep === -1 ? argv.length : sep;
    for (var i = 0; i < end; i++) {
      var a = argv[i];
      if (typeof a !== "string") continue;
      var m = ARG_RE.exec(a);
      if (m) return m[1];
    }
    return undefined;
  }

  function isLaunchArgv(argv) {
    return parseInstallId(argv) !== undefined;
  }

  function queueLaunch(argv) {
    var id = parseInstallId(argv);
    if (!id) return false;
    var now = Date.now();
    launchQueue = launchQueue.filter(function (item) {
      return now - item.at < QUEUE_TTL_MS;
    });
    launchQueue.push({ installId: id, argv: argv.slice(), at: now });
    return true;
  }

  function drainLaunches() {
    var now = Date.now();
    var out = [];
    var seen = Object.create(null);
    var items = [{ argv: process.argv, at: now }].concat(launchQueue);
    launchQueue = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (now - it.at >= QUEUE_TTL_MS) continue;
      var id = parseInstallId(it.argv);
      if (id && !seen[id]) {
        seen[id] = true;
        out.push({ installId: id, argv: it.argv });
      }
    }
    return out;
  }

  function newInstallId(deps) {
    var crypto = (deps && deps.crypto) || require("node:crypto");
    return crypto.randomBytes(16).toString("hex");
  }

  function desktopIdFor(installId, env) {
    var prof = profileName(env);
    var prefix = prof ? BASE_APP_ID + "-" + prof : BASE_APP_ID;
    return prefix + ".artifact-" + installId;
  }

  function desktopFileNameFor(installId, env) {
    return desktopIdFor(installId, env) + ".desktop";
  }

  function xdgDataHome(deps) {
    var path = (deps && deps.path) || require("node:path");
    var os = (deps && deps.os) || require("node:os");
    var env = (deps && deps.env) || process.env;
    var xdg = env.XDG_DATA_HOME;
    if (typeof xdg === "string" && path.isAbsolute(xdg)) return xdg;
    return path.join(os.homedir(), ".local", "share");
  }

  function applicationsDir(deps) {
    var path = (deps && deps.path) || require("node:path");
    return path.join(xdgDataHome(deps), "applications");
  }

  function iconPathsFor(installId, userDataDir, deps) {
    var path = (deps && deps.path) || require("node:path");
    var dataHome = xdgDataHome(deps);
    var id = desktopIdFor(installId, deps && deps.env);
    return {
      desktopId: id,
      png256: path.join(dataHome, "icons", "hicolor", "256x256", "apps", id + ".png"),
      png512: path.join(dataHome, "icons", "hicolor", "512x512", "apps", id + ".png"),
      local: path.join(userDataDir, "artifact-apps", "icons", installId + ".png"),
    };
  }

  function resolveLauncherPath(deps) {
    var fs = (deps && deps.fs) || require("node:fs");
    var env = (deps && deps.env) || process.env;
    if (typeof env.CLAUDE_LAUNCHER === "string" && env.CLAUDE_LAUNCHER.trim() !== "") {
      return env.CLAUDE_LAUNCHER.trim();
    }
    if (typeof env.APPIMAGE === "string" && env.APPIMAGE.trim() !== "") {
      return env.APPIMAGE.trim();
    }
    try {
      if (fs.existsSync("/usr/bin/claude-desktop")) return "/usr/bin/claude-desktop";
    } catch (_) {}
    return "claude-desktop";
  }

  function escapeDesktopExecArg(arg) {
    var s = String(arg);
    if (s === "" || /[\s"'`\\$><~|&;*?#()\[\]{}]/.test(s)) {
      return '"' + s.replace(/([\\"`$])/g, "\\$1") + '"';
    }
    return s;
  }

  function escapeDesktopValue(val) {
    return String(val ?? "")
      .replace(/[\r\n\0]+/g, " ")
      .trim();
  }

  function buildDesktopEntry(opts, deps) {
    var env = (deps && deps.env) || process.env;
    var installId = opts.installId;
    var artifactUuid = opts.artifactUuid;
    var name = escapeDesktopValue(opts.name) || "Untitled artifact";
    var desktopId = desktopIdFor(installId, env);
    var launcher = resolveLauncherPath(deps);
    var execParts = [escapeDesktopExecArg(launcher)];
    var prof = profileName(env);
    if (prof) execParts.push(escapeDesktopExecArg("--profile=" + prof));
    execParts.push(escapeDesktopExecArg(ARG_PREFIX + installId));
    var iconKey = opts.hasIcon === false ? "claude-desktop" : desktopId;

    return [
      "[Desktop Entry]",
      "Type=Application",
      "Version=1.5",
      "Name=" + name,
      "Comment=Installed Claude Artifact App",
      "Exec=" + execParts.join(" "),
      "Icon=" + iconKey,
      "Terminal=false",
      "Categories=Utility;",
      "StartupNotify=true",
      "StartupWMClass=" + desktopId,
      "X-Claude-Artifact-App-Id=" + installId,
      "X-Claude-Artifact-Uuid=" + artifactUuid,
      "",
    ].join("\n");
  }

  async function writeFileAtomic(filePath, data, mode, deps) {
    var fs = (deps && deps.fs) || require("node:fs");
    var fsp = fs.promises;
    var path = (deps && deps.path) || require("node:path");
    var crypto = (deps && deps.crypto) || require("node:crypto");
    var dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    var suffix = crypto.randomBytes(6).toString("hex");
    var tmp = path.join(dir, "." + path.basename(filePath) + ".tmp-" + process.pid + "-" + suffix);
    try {
      await fsp.writeFile(tmp, data, { mode: mode || 0o644 });
      await fsp.rename(tmp, filePath);
    } catch (err) {
      await fsp.unlink(tmp).catch(function () {});
      throw err;
    }
  }

  function refreshDesktopCaches(deps) {
    try {
      var cp = (deps && deps.child_process) || require("node:child_process");
      var path = (deps && deps.path) || require("node:path");
      var appDir = applicationsDir(deps);
      var iconDir = path.join(xdgDataHome(deps), "icons", "hicolor");
      var execFile = cp.execFile;
      if (typeof execFile !== "function") return;
      var run = function (cmd, args) {
        try {
          var child = execFile(cmd, args, { timeout: CACHE_TOOL_TIMEOUT_MS }, function () {});
          if (child && typeof child.unref === "function") child.unref();
        } catch (_) {}
      };
      run("update-desktop-database", [appDir]);
      run("gtk-update-icon-cache", ["-f", "-t", iconDir]);
    } catch (_) {}
  }

  function parseDesktopFile(text) {
    var out = { inDesktopEntry: false, hidden: false, noDisplay: false, name: null, installId: null };
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line[0] === "#") continue;
      if (line[0] === "[" && line[line.length - 1] === "]") {
        out.inDesktopEntry = line === "[Desktop Entry]";
        continue;
      }
      if (!out.inDesktopEntry) continue;
      var eq = line.indexOf("=");
      if (eq === -1) continue;
      var k = line.slice(0, eq).trim();
      var v = line.slice(eq + 1).trim();
      if (k === "Hidden") out.hidden = v === "true";
      else if (k === "NoDisplay") out.noDisplay = v === "true";
      else if (k === "Name") out.name = v;
      else if (k === "X-Claude-Artifact-App-Id" && /^[0-9a-f]{32}$/.test(v)) out.installId = v;
    }
    return out;
  }

  async function writeIcons(installId, nativeImg, userDataDir, deps) {
    if (!nativeImg || (typeof nativeImg.isEmpty === "function" && nativeImg.isEmpty())) {
      return null;
    }
    var paths = iconPathsFor(installId, userDataDir, deps);
    var png256 = nativeImg.resize({ width: 256, height: 256, quality: "best" }).toPNG();
    var png512 = nativeImg.resize({ width: 512, height: 512, quality: "best" }).toPNG();
    await writeFileAtomic(paths.png256, png256, 0o644, deps);
    await writeFileAtomic(paths.png512, png512, 0o644, deps);
    await writeFileAtomic(paths.local, png256, 0o644, deps);
    return paths.local;
  }

  async function installDesktopEntry(opts, deps) {
    var path = (deps && deps.path) || require("node:path");
    var env = (deps && deps.env) || process.env;
    var installId = opts.installId;
    var userDataDir = opts.userDataDir;
    var iconPath = null;
    if (opts.image) {
      iconPath = await writeIcons(installId, opts.image, userDataDir, deps);
    }
    var desktopFile = desktopFileNameFor(installId, env);
    var desktopPath = path.join(applicationsDir(deps), desktopFile);
    var content = buildDesktopEntry(
      {
        installId: installId,
        artifactUuid: opts.artifactUuid,
        name: opts.name,
        hasIcon: iconPath !== null,
      },
      deps
    );
    await writeFileAtomic(desktopPath, content, 0o644, deps);
    refreshDesktopCaches(deps);
    diag("[artifactApps] installed desktop entry " + desktopPath);
    return { desktopFile: desktopFile, desktopPath: desktopPath, iconPath: iconPath };
  }

  async function updateAppIcon(opts, deps) {
    var installId = opts.installId;
    var image = opts.image;
    var userDataDir = opts.userDataDir;
    if (!installId || !image || !userDataDir) return false;
    var fs = (deps && deps.fs) || require("node:fs");
    var path = (deps && deps.path) || require("node:path");
    var paths = iconPathsFor(installId, userDataDir, deps);
    var png256 = image.resize({ width: 256, height: 256, quality: "best" }).toPNG();
    try {
      var prev = await fs.promises.readFile(paths.local);
      if (prev && prev.equals(png256)) return false;
    } catch (_) {}
    await writeIcons(installId, image, userDataDir, deps);
    var desktopFile = opts.desktopFile || desktopFileNameFor(installId, deps && deps.env);
    var desktopPath = path.join(applicationsDir(deps), desktopFile);
    try {
      var raw = await fs.promises.readFile(desktopPath, "utf8");
      if (/^Icon=claude-desktop$/m.test(raw)) {
        var next = raw.replace(/^Icon=claude-desktop$/m, "Icon=" + desktopIdFor(installId, deps && deps.env));
        await writeFileAtomic(desktopPath, next, 0o644, deps);
      }
    } catch (_) {}
    if (opts.openWindow && !opts.openWindow.isDestroyed() && typeof opts.openWindow.setIcon === "function") {
      try {
        opts.openWindow.setIcon(image);
      } catch (_) {}
    }
    refreshDesktopCaches(deps);
    return true;
  }

  async function readDesktopEntriesMap(dir, deps) {
    var fs = (deps && deps.fs) || require("node:fs");
    var path = (deps && deps.path) || require("node:path");
    var byId = Object.create(null);
    var entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return byId;
    }
    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      if (!ent.name || ent.name[0] === "." || !ent.name.endsWith(".desktop")) continue;
      if (typeof ent.isFile === "function" && !ent.isFile() && !(typeof ent.isSymbolicLink === "function" && ent.isSymbolicLink())) {
        continue;
      }
      try {
        var raw = await fs.promises.readFile(path.join(dir, ent.name), "utf8");
        var parsed = parseDesktopFile(raw);
        if (parsed.installId) {
          var prev = byId[parsed.installId];
          // A Hidden=true file masks/removes the entry
          if (!prev || parsed.hidden) {
            byId[parsed.installId] = {
              fileName: ent.name,
              name: parsed.name,
              hidden: parsed.hidden,
            };
          }
        }
      } catch (_) {}
    }
    return byId;
  }

  async function reconcileRecords(records, deps) {
    if (!Array.isArray(records) || records.length === 0) {
      return { kept: records || [], removed: [], changed: false };
    }
    var appDir = applicationsDir(deps);
    var fs = (deps && deps.fs) || require("node:fs");
    var path = (deps && deps.path) || require("node:path");
    try {
      await fs.promises.access(appDir);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        // Directory does not exist yet: every previously installed entry is gone
        return { kept: [], removed: records.slice(), changed: records.length > 0 };
      }
      return { kept: records.slice(), removed: [], changed: false };
    }
    var byId = await readDesktopEntriesMap(appDir, deps);
    var kept = [];
    var removed = [];
    var changed = false;
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var hit = byId[rec.installId];
      // Also check direct desktopFile path if X-Claude-Artifact-App-Id was edited out
      if (!hit && rec.desktopFile) {
        try {
          var directRaw = await fs.promises.readFile(path.join(appDir, rec.desktopFile), "utf8");
          var directParsed = parseDesktopFile(directRaw);
          if (!directParsed.hidden) {
            hit = { fileName: rec.desktopFile, name: directParsed.name || rec.name, hidden: false };
          } else {
            hit = { fileName: rec.desktopFile, name: directParsed.name || rec.name, hidden: true };
          }
        } catch (_) {}
      }
      if (!hit || hit.hidden) {
        removed.push(rec);
        changed = true;
      } else {
        var nextName = hit.name || rec.name;
        var nextFile = hit.fileName || rec.desktopFile;
        if (nextName !== rec.name || nextFile !== rec.desktopFile) {
          changed = true;
          kept.push(Object.assign({}, rec, { name: nextName, desktopFile: nextFile }));
        } else {
          kept.push(rec);
        }
      }
    }
    return { kept: kept, removed: removed, changed: changed };
  }

  async function listExistingAppNames(deps) {
    var fs = (deps && deps.fs) || require("node:fs");
    var path = (deps && deps.path) || require("node:path");
    var env = (deps && deps.env) || process.env;
    var dirs = [applicationsDir(deps)];
    var dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
    for (var i = 0; i < dataDirs.length; i++) {
      if (dataDirs[i] && path.isAbsolute(dataDirs[i])) {
        dirs.push(path.join(dataDirs[i], "applications"));
      }
    }
    var names = [];
    for (var d = 0; d < dirs.length; d++) {
      var files;
      try {
        files = await fs.promises.readdir(dirs[d]);
      } catch (_) {
        continue;
      }
      for (var f = 0; f < files.length; f++) {
        if (!files[f].endsWith(".desktop")) continue;
        try {
          var raw = await fs.promises.readFile(path.join(dirs[d], files[f]), "utf8");
          var parsed = parseDesktopFile(raw);
          if (!parsed.hidden && !parsed.noDisplay && parsed.name) {
            names.push(parsed.name);
          }
        } catch (_) {}
      }
    }
    return names;
  }

  async function findFreeName(baseName, existingRecords, deps) {
    var used = Object.create(null);
    if (Array.isArray(existingRecords)) {
      for (var i = 0; i < existingRecords.length; i++) {
        var n = existingRecords[i] && existingRecords[i].name;
        if (typeof n === "string") used[n.toLowerCase()] = true;
      }
    }
    var appNames = await listExistingAppNames(deps).catch(function () {
      return [];
    });
    for (var j = 0; j < appNames.length; j++) {
      used[appNames[j].toLowerCase()] = true;
    }
    for (var idx = 1; idx < 100; idx++) {
      var cand = idx === 1 ? baseName : baseName + " " + idx;
      if (!used[cand.toLowerCase()]) return cand;
    }
    throw Error("no free app name");
  }

  function desktopEntryPath(record, deps) {
    if (!record) return null;
    var fs = (deps && deps.fs) || require("node:fs");
    var path = (deps && deps.path) || require("node:path");
    var file = record.desktopFile || desktopFileNameFor(record.installId, deps && deps.env);
    var p = path.join(applicationsDir(deps), file);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) {}
    return null;
  }

  async function uninstallDesktopEntry(record, userDataDir, deps) {
    var fs = (deps && deps.fs) || require("node:fs");
    var path = (deps && deps.path) || require("node:path");
    var file = record.desktopFile || desktopFileNameFor(record.installId, deps && deps.env);
    var desktopPath = path.join(applicationsDir(deps), file);
    var existed = false;
    try {
      await fs.promises.unlink(desktopPath);
      existed = true;
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    var icons = iconPathsFor(record.installId, userDataDir, deps);
    var iconList = [icons.png256, icons.png512, icons.local];
    for (var i = 0; i < iconList.length; i++) {
      await fs.promises.unlink(iconList[i]).catch(function () {});
    }
    if (existed) refreshDesktopCaches(deps);
    diag("[artifactApps] uninstalled desktop entry " + desktopPath + " (existed=" + existed + ")");
    return { existed: existed, desktopPath: desktopPath };
  }

  function createWindow(BrowserWindowCtor, app, opts, record, deps) {
    var winOpts = Object.assign({}, opts);
    var env = (deps && deps.env) || process.env;
    var fs = (deps && deps.fs) || require("node:fs");
    var path = (deps && deps.path) || require("node:path");
    var nativeImage = (deps && deps.nativeImage) || require("electron").nativeImage;

    var desktopFile = null;
    if (record && record.installId) {
      try {
        var userDataDir = app && typeof app.getPath === "function" ? app.getPath("userData") : "";
        if (userDataDir && nativeImage && typeof nativeImage.createFromPath === "function") {
          var localIcon = iconPathsFor(record.installId, userDataDir, deps).local;
          if (fs.existsSync(localIcon)) {
            var img = nativeImage.createFromPath(localIcon);
            if (img && (typeof img.isEmpty !== "function" || !img.isEmpty())) {
              winOpts.icon = img;
            }
          }
        }
      } catch (_) {}

      try {
        var df = record.desktopFile || desktopFileNameFor(record.installId, env);
        var dp = path.join(applicationsDir(deps), df);
        if (fs.statSync(dp).isFile()) {
          var parsed = parseDesktopFile(fs.readFileSync(dp, "utf8"));
          if (!parsed.hidden) desktopFile = df;
        }
      } catch (_) {}
    }

    if (!desktopFile) {
      return new BrowserWindowCtor(winOpts);
    }

    var prevDesktop = env.CHROME_DESKTOP;
    var setName = app && typeof app.setDesktopName === "function" ? app.setDesktopName : null;
    try {
      env.CHROME_DESKTOP = desktopFile;
      if (setName) setName.call(app, desktopFile);
      return new BrowserWindowCtor(winOpts);
    } finally {
      try {
        if (typeof prevDesktop === "string") {
          env.CHROME_DESKTOP = prevDesktop;
          if (setName) setName.call(app, prevDesktop);
        } else {
          delete env.CHROME_DESKTOP;
        }
      } catch (restoreErr) {
        diag("[artifactApps] app_id restore failed: " + (restoreErr && restoreErr.message));
      }
    }
  }

  function setBadge(app, badge) {
    if (!app || typeof app.setBadgeCount !== "function") return false;
    var s = String(badge ?? "").trim();
    if (s === "") {
      try {
        return app.setBadgeCount(0) !== false;
      } catch (_) {
        return false;
      }
    }
    if (/^\d+$/.test(s)) {
      var n = parseInt(s, 10);
      if (Number.isFinite(n) && n >= 0) {
        try {
          return app.setBadgeCount(n) !== false;
        } catch (_) {
          return false;
        }
      }
    }
    return false;
  }

  function handleSecondInstance(argv, getMod, loadMod, onOrgBlocked) {
    var id = parseInstallId(argv);
    if (!id) return false;
    var mod = typeof getMod === "function" ? getMod("evenWhenOff") : null;
    if (mod && typeof mod.openFromCommandLine === "function") {
      try {
        var opened = mod.openFromCommandLine(argv);
        if (!opened && typeof onOrgBlocked === "function") onOrgBlocked();
      } catch (err) {
        diag("[artifactApps] second-instance open failed: " + (err && err.message));
      }
      return true;
    }
    queueLaunch(argv);
    if (typeof loadMod === "function") {
      Promise.resolve(loadMod()).catch(function (err) {
        diag("[artifactApps] lazy load on second-instance failed: " + (err && err.message));
      });
    }
    return true;
  }

  function registerHooks(h) {
    hooks = h;
  }

  function openFromCommandLine(argv) {
    var id = parseInstallId(argv);
    if (!id || !hooks) return false;
    try {
      if (!hooks.isEnabled()) return false;
      var rec = hooks.findByInstallId(id);
      if (!rec) {
        diag("[artifactApps] launch requested for unknown installId " + id);
        return false;
      }
      hooks.markLaunched();
      return !!hooks.openRecord(rec);
    } catch (err) {
      diag("[artifactApps] openFromCommandLine failed: " + (err && err.message));
      return false;
    }
  }

  function drainQueuedOnReady() {
    var queued = drainLaunches();
    if (!queued.length || !hooks) return 0;
    var opened = 0;
    for (var i = 0; i < queued.length; i++) {
      if (openFromCommandLine(queued[i].argv)) opened++;
    }
    return opened;
  }

  var api = {
    marker: MARKER,
    ARG_PREFIX: ARG_PREFIX,
    newInstallId: newInstallId,
    parseInstallId: parseInstallId,
    isLaunchArgv: isLaunchArgv,
    queueLaunch: queueLaunch,
    drainLaunches: drainLaunches,
    profileName: profileName,
    desktopIdFor: desktopIdFor,
    desktopFileNameFor: desktopFileNameFor,
    xdgDataHome: xdgDataHome,
    applicationsDir: applicationsDir,
    iconPathsFor: iconPathsFor,
    resolveLauncherPath: resolveLauncherPath,
    escapeDesktopExecArg: escapeDesktopExecArg,
    escapeDesktopValue: escapeDesktopValue,
    buildDesktopEntry: buildDesktopEntry,
    parseDesktopFile: parseDesktopFile,
    installDesktopEntry: installDesktopEntry,
    updateAppIcon: updateAppIcon,
    reconcileRecords: reconcileRecords,
    listExistingAppNames: listExistingAppNames,
    findFreeName: findFreeName,
    desktopEntryPath: desktopEntryPath,
    uninstallDesktopEntry: uninstallDesktopEntry,
    createWindow: createWindow,
    setBadge: setBadge,
    handleSecondInstance: handleSecondInstance,
    registerHooks: registerHooks,
    openFromCommandLine: openFromCommandLine,
    drainQueuedOnReady: drainQueuedOnReady,
  };

  globalThis.__cdbArtifactApps = api;
  if (typeof globalThis.__cdbArtifactAppsModuleExport === "function") {
    globalThis.__cdbArtifactAppsModuleExport(api);
  }
})();
