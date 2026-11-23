/*
 * custom_shortcuts_main.js - main-process half of Custom Shortcuts (issues
 * #350, #352). Embedded by patches/community/add_feature_custom_shortcuts.nim.
 *
 * Manages:
 *   - Config persistence under `customShortcuts` in
 *     <userData>/claude-desktop-extra.json (.jsonc overrides and locks).
 *   - Accelerator normalization, modifier + reserved-chord + duplicate checks.
 *   - Layout-aware in-app matching via webContents.on("before-input-event").
 *   - Optional Electron globalShortcut registration (on X11, XWayland, and
 *     Wayland sessions with org.freedesktop.portal.GlobalShortcuts).
 *   - Sender-guarded cdb-shortcuts:* IPCs for Settings -> Extra -> Custom
 *     Shortcuts and the Community Features switch.
 *   - globalThis.__cdbCustomShortcuts.trigger(actionId, source) for the CLI /
 *     Unix socket trigger (--trigger-shortcut).
 *
 * SECURITY: the renderer is remote claude.ai code. Every IPC handler runs
 * behind globalThis.__cdbSenderGuard (fail-closed) and re-validates every
 * argument shape and accelerator string on the main side.
 */
;/*__CDB_CUSTOM_SHORTCUTS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbCustomShortcutsMain) return;
  globalThis.__cdbCustomShortcutsMain = true;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _bw = _electron.BrowserWindow;
  var _wc = _electron.webContents;
  var _gs = _electron.globalShortcut;
  var _fs = require("fs");
  var _path = require("path");
  var _cp = require("child_process");
  var _URL = require("url").URL;

  var PAGE_SRC = "__CDB_SHORTCUTS_PAGE_SRC__";
  var PREF_KEY = "customShortcuts";
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";
  var RECORDING_TTL_MS = 60000;
  var PORTAL_TIMEOUT_MS = 2500;

  var ACTIONS = [
    {
      id: "voiceMode",
      slug: "voice-mode",
      title: "Voice mode in current chat",
      description: "Open or exit Voice mode in the chat you have open.",
      focusWindow: true
    },
    {
      id: "newVoiceChat",
      slug: "new-voice-chat",
      title: "New voice chat",
      description: "Open a new chat thread and start Voice mode immediately.",
      focusWindow: true
    },
    {
      id: "readAloud",
      slug: "read-aloud",
      title: "Read aloud latest reply",
      description: "Start, pause, or resume Read Aloud on Claude's newest reply.",
      focusWindow: false
    },
    {
      id: "sendNow",
      slug: "send-now",
      title: "Send queued message now",
      description: "Click \"Send now\" on a queued message so Claude reads it immediately instead of waiting for the current turn.",
      focusWindow: false
    }
  ];

  var ACTION_BY_ID = Object.create(null);
  var ACTION_BY_SLUG = Object.create(null);
  ACTIONS.forEach(function (a) {
    ACTION_BY_ID[a.id] = a;
    ACTION_BY_SLUG[a.slug] = a;
  });

  function lookupAction(key) {
    return (typeof key === "string" && Object.prototype.hasOwnProperty.call(ACTION_BY_ID, key))
      ? ACTION_BY_ID[key] : null;
  }
  function lookupActionAny(key) {
    if (typeof key !== "string") return null;
    if (Object.prototype.hasOwnProperty.call(ACTION_BY_ID, key)) return ACTION_BY_ID[key];
    if (Object.prototype.hasOwnProperty.call(ACTION_BY_SLUG, key)) return ACTION_BY_SLUG[key];
    return null;
  }

  var ALLOWED_FALLBACK_ORIGINS = [
    "https://claude.ai",
    "https://preview.claude.ai",
    "https://claude.com",
    "https://preview.claude.com",
    "app://localhost"
  ];

  // Queued logger: __cdbDiag is installed on upstream `ready`.
  var logQueue = [];
  function emitLog(line) {
    try { (globalThis.__cdbDiag || console.log)(line); } catch (e) {}
  }
  function flushLog() {
    var q = logQueue;
    logQueue = null;
    for (var i = 0; q && i < q.length; i++) emitLog(q[i]);
  }
  function log(m) {
    var line = "[custom-shortcuts] " + m;
    if (logQueue && typeof globalThis.__cdbDiag !== "function") { logQueue.push(line); return; }
    flushLog();
    emitLog(line);
  }
  try {
    if (_app && typeof _app.whenReady === "function") {
      _app.whenReady().then(function () { setTimeout(flushLog, 0); }, function () {});
    }
  } catch (e) { setTimeout(flushLog, 0); }

  function originAllowed(rawUrl) {
    var sg = globalThis.__cdbSenderGuard;
    if (sg && typeof sg.originAllowed === "function") return sg.originAllowed(rawUrl);
    try {
      var u = new _URL(String(rawUrl || ""));
      var o = u.origin;
      if (!o || o === "null") o = u.protocol + "//" + u.host;
      return ALLOWED_FALLBACK_ORIGINS.indexOf(o) >= 0;
    } catch (e) {
      return false;
    }
  }

  function isEligibleUrl(rawUrl) {
    var s = String(rawUrl || "");
    if (!originAllowed(s)) return false;
    if (/^app:\/\/localhost\/setup-desktop-3p(?:[\/?#]|$)/i.test(s)) return false;
    if (/quick_window\/quick-window\.html(?:[?#]|$)/i.test(s)) return false;
    return true;
  }

  function okSender(ev) {
    var sg = globalThis.__cdbSenderGuard;
    if (!sg || typeof sg.okSender !== "function") return false;
    return sg.okSender(ev) === true;
  }

  function userDir() {
    try { return _app.getPath("userData"); } catch (e) { return null; }
  }

  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = userDir();
    return d ? _path.join(d, name) : null;
  }

  // String-aware JSONC comment + trailing-comma scanner matching __cdbEx_strip().
  function stripComments(s) {
    var src = String(s || "");
    var out = "", inStr = false, i = 0;
    while (i < src.length) {
      var c = src[i];
      if (inStr) {
        out += c;
        if (c === "\\" && i + 1 < src.length) { out += src[i + 1]; i++; }
        else if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === ",") {
        var j = i + 1;
        while (j < src.length) {
          if (src[j] === " " || src[j] === "\t" || src[j] === "\r" || src[j] === "\n") { j++; continue; }
          if (src[j] === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n") j++; continue; }
          if (src[j] === "/" && src[j + 1] === "*") {
            j += 2;
            while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
            j += 2;
            continue;
          }
          break;
        }
        if (src[j] === "}" || src[j] === "]") { i++; continue; }
      }
      out += c;
      i++;
    }
    return out;
  }

  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var stripped = stripComments(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) {
      return null;
    }
  }

  // --- Accelerator normalization and validation ----------------------------

  var MOD_ALIASES = {
    ctrl: "Ctrl",
    control: "Ctrl",
    commandorcontrol: "Ctrl",
    cmdorctrl: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    super: "Super",
    meta: "Super",
    command: "Super",
    cmd: "Super"
  };

  var NAMED_KEY_ALIASES = {
    space: "Space",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    insert: "Insert",
    enter: "Return",
    return: "Return",
    up: "Up",
    arrowup: "Up",
    down: "Down",
    arrowdown: "Down",
    left: "Left",
    arrowleft: "Left",
    right: "Right",
    arrowright: "Right",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    plus: "Plus",
    minus: "-",
    equal: "=",
    comma: ",",
    period: ".",
    slash: "/",
    backslash: "\\",
    semicolon: ";",
    quote: "'",
    backquote: "`",
    bracketleft: "[",
    bracketright: "]",
    numdec: "numdec",
    numadd: "numadd",
    numsub: "numsub",
    nummult: "nummult",
    numdiv: "numdiv"
  };

  var PUNCT_CODE = {
    "-": "Minus",
    "=": "Equal",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    "`": "Backquote",
    "[": "BracketLeft",
    "]": "BracketRight"
  };

  var NAMED_PUNCT = new Set(["-", "=", ",", ".", "/", "\\", ";", "'", "`", "[", "]"]);

  var RESERVED_CHORDS = new Set([
    "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Ctrl+Y",
    "Ctrl+W", "Ctrl+Q", "Ctrl+N", "Ctrl+T", "Ctrl+R", "Ctrl+F",
    "Ctrl+P", "Ctrl+D", "Ctrl+,", "Ctrl+Tab", "Ctrl+Shift+Tab",
    "Ctrl+Shift+I", "Ctrl+Alt+I", "Ctrl+Shift+T", "Ctrl+Shift+J",
    "Ctrl+Alt+Space", "Ctrl+Shift+P", "Ctrl+Shift+R",
    "Alt+F4", "F5", "F11", "F12"
  ]);

  function splitShortcutTokens(raw) {
    var str = String(raw || "").trim();
    if (!str) return [];
    // Handle a trailing "+" such as "Ctrl++" by converting "++" -> "+Plus" before split.
    if (str.slice(-2) === "++") str = str.slice(0, -1) + "Plus";
    return str.split("+").map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
  }

  function parseAccelerator(raw) {
    var trimmed = String(raw || "").trim();
    if (!trimmed) return { ok: true, empty: true, canonical: "", electron: "" };
    if (trimmed.length > 80) return { ok: false, error: "Shortcut string is too long" };

    var parts = splitShortcutTokens(trimmed);
    if (!parts.length) return { ok: false, error: "Invalid shortcut format" };

    var mods = { ctrl: false, alt: false, shift: false, super: false };
    var key = null;

    for (var i = 0; i < parts.length; i++) {
      var tok = parts[i];
      var low = tok.toLowerCase();
      if (low === "altgr" || low === "altgraph") {
        return { ok: false, error: "AltGr cannot be used in a custom shortcut" };
      }
      if (Object.prototype.hasOwnProperty.call(MOD_ALIASES, low)) {
        var mName = MOD_ALIASES[low];
        if (mName === "Ctrl") mods.ctrl = true;
        else if (mName === "Alt") mods.alt = true;
        else if (mName === "Shift") mods.shift = true;
        else if (mName === "Super") mods.super = true;
        continue;
      }
      if (key !== null) {
        return { ok: false, error: "Only one non-modifier key is allowed per shortcut" };
      }
      if (/^[a-zA-Z]$/.test(tok)) {
        key = tok.toUpperCase();
      } else if (/^[0-9]$/.test(tok)) {
        key = tok;
      } else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(tok)) {
        key = "F" + tok.slice(1);
      } else if (/^num[0-9]$/i.test(tok)) {
        key = "num" + tok.slice(3);
      } else if (Object.prototype.hasOwnProperty.call(NAMED_KEY_ALIASES, low)) {
        key = NAMED_KEY_ALIASES[low];
      } else if (NAMED_PUNCT.has(tok)) {
        key = tok;
      } else {
        return { ok: false, error: "Unsupported key \"" + tok + "\"" };
      }
    }

    if (!key) {
      return { ok: false, error: "Press a non-modifier key together with a modifier" };
    }
    if (key === "Esc" || key === "Escape") {
      return { ok: false, error: "Escape cannot be used as a shortcut key" };
    }

    var isFnKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    var hasPrimaryMod = mods.ctrl || mods.alt || mods.super;
    if (!hasPrimaryMod && !isFnKey) {
      return {
        ok: false,
        error: mods.shift
          ? "Add Ctrl, Alt, or Super (Shift alone interferes with typing)"
          : "Add a modifier key like Ctrl or Alt (or use a function key)"
      };
    }

    var modList = [];
    var electronModList = [];
    if (mods.ctrl) { modList.push("Ctrl"); electronModList.push("Control"); }
    if (mods.alt) { modList.push("Alt"); electronModList.push("Alt"); }
    if (mods.shift) { modList.push("Shift"); electronModList.push("Shift"); }
    if (mods.super) { modList.push("Super"); electronModList.push("Super"); }

    var canonical = modList.concat([key]).join("+");
    var electronAccel = electronModList.concat([key]).join("+");

    if (RESERVED_CHORDS.has(canonical)) {
      return {
        ok: false,
        error: "\"" + canonical + "\" is reserved for standard app or editing shortcuts"
      };
    }

    return {
      ok: true,
      empty: false,
      canonical: canonical,
      electron: electronAccel,
      ctrl: mods.ctrl,
      alt: mods.alt,
      shift: mods.shift,
      super: mods.super,
      key: key
    };
  }

  function normalizeBindingSpec(raw) {
    if (typeof raw === "string") {
      var parsedStr = parseAccelerator(raw);
      return {
        accelerator: parsedStr.ok && !parsedStr.empty ? parsedStr.canonical : "",
        scope: "app",
        invalidRaw: parsedStr.ok ? null : raw
      };
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      var scope = raw.scope === "global" ? "global" : "app";
      var parsedObj = parseAccelerator(typeof raw.accelerator === "string" ? raw.accelerator : "");
      return {
        accelerator: parsedObj.ok && !parsedObj.empty ? parsedObj.canonical : "",
        scope: scope,
        invalidRaw: parsedObj.ok ? null : String(raw.accelerator || "")
      };
    }
    return { accelerator: "", scope: "app", invalidRaw: null };
  }

  function readMergedConfig() {
    var jsonc = readFileJson(pathFor(JSONC_NAME));
    var json = readFileJson(pathFor(JSON_NAME));

    var jcRaw = jsonc ? jsonc[PREF_KEY] : undefined;
    var jsRaw = json ? json[PREF_KEY] : undefined;

    var enabled = false;
    var enabledLocked = false;
    var enabledSource = "default";

    if (typeof jcRaw === "boolean") {
      enabled = jcRaw;
      enabledLocked = true;
      enabledSource = "jsonc-locked";
    } else if (jcRaw && typeof jcRaw === "object" && !Array.isArray(jcRaw) && typeof jcRaw.enabled === "boolean") {
      enabled = jcRaw.enabled;
      enabledLocked = true;
      enabledSource = "jsonc-locked";
    } else if (jsRaw && typeof jsRaw === "object" && !Array.isArray(jsRaw) && typeof jsRaw.enabled === "boolean") {
      enabled = jsRaw.enabled;
      enabledSource = "json";
    }

    var jcBindings = (jcRaw && typeof jcRaw === "object" && !Array.isArray(jcRaw) &&
      jcRaw.bindings && typeof jcRaw.bindings === "object" && !Array.isArray(jcRaw.bindings))
      ? jcRaw.bindings : null;
    var jsBindings = (jsRaw && typeof jsRaw === "object" && !Array.isArray(jsRaw) &&
      jsRaw.bindings && typeof jsRaw.bindings === "object" && !Array.isArray(jsRaw.bindings))
      ? jsRaw.bindings : null;

    var bindings = Object.create(null);
    var seenAccels = Object.create(null);

    // Resolve .jsonc-locked bindings first so an unlocked .json entry never
    // steals or nullifies a locked .jsonc chord on collision.
    var orderedActions = ACTIONS.slice().sort(function (a, b) {
      var la = (jcRaw === false || (jcBindings && Object.prototype.hasOwnProperty.call(jcBindings, a.id))) ? 0 : 1;
      var lb = (jcRaw === false || (jcBindings && Object.prototype.hasOwnProperty.call(jcBindings, b.id))) ? 0 : 1;
      return la - lb;
    });

    orderedActions.forEach(function (act) {
      var id = act.id;
      var locked = jcRaw === false || !!(jcBindings && Object.prototype.hasOwnProperty.call(jcBindings, id));
      var chosen = jcRaw === false
        ? { accelerator: "", scope: "app" }
        : locked
          ? normalizeBindingSpec(jcBindings[id])
          : (jsBindings && Object.prototype.hasOwnProperty.call(jsBindings, id))
            ? normalizeBindingSpec(jsBindings[id])
            : { accelerator: "", scope: "app" };
      if (chosen.accelerator && seenAccels[chosen.accelerator]) {
        chosen = { accelerator: "", scope: chosen.scope, duplicateOf: seenAccels[chosen.accelerator] };
      } else if (chosen.accelerator) {
        seenAccels[chosen.accelerator] = id;
      }
      var parsed = parseAccelerator(chosen.accelerator);
      bindings[id] = {
        accelerator: chosen.accelerator,
        scope: chosen.scope,
        locked: locked,
        parsed: (parsed.ok && !parsed.empty) ? parsed : null
      };
    });

    return {
      enabled: enabled,
      enabledLocked: enabledLocked,
      enabledSource: enabledSource,
      lockedByJsonc: enabledLocked,
      bindings: bindings
    };
  }

  function isDefaultStoredObj(obj) {
    if (!obj || typeof obj !== "object") return true;
    if (obj.enabled === true) return false;
    var b = obj.bindings;
    if (!b || typeof b !== "object") return true;
    for (var i = 0; i < ACTIONS.length; i++) {
      var entry = b[ACTIONS[i].id];
      if (!entry) continue;
      if (entry.accelerator) return false;
      if (entry.scope && entry.scope !== "app") return false;
    }
    return true;
  }

  function mutateJsonConfig(fn) {
    var p = pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try {
      raw = _fs.readFileSync(p, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") {
        return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || String(e)) };
      }
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = stripComments(raw);
      try {
        cfg = stripped.trim() ? JSON.parse(stripped) : {};
      } catch (e2) {
        return {
          ok: false,
          error: p + " is not valid JSON (" + e2.message + ") - fix or remove it first; nothing was written"
        };
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      }
      if (stripped !== raw) {
        try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }

    var cur = (cfg[PREF_KEY] && typeof cfg[PREF_KEY] === "object" && !Array.isArray(cfg[PREF_KEY]))
      ? JSON.parse(JSON.stringify(cfg[PREF_KEY]))
      : {};
    if (!cur.bindings || typeof cur.bindings !== "object" || Array.isArray(cur.bindings)) {
      cur.bindings = {};
    }

    var err = fn(cur);
    if (err) return { ok: false, error: err };

    // Prune clean empty binding entries.
    Object.keys(cur.bindings).forEach(function (k) {
      if (!lookupAction(k)) { delete cur.bindings[k]; return; }
      var e = cur.bindings[k];
      if (!e || typeof e !== "object" || (!e.accelerator && (!e.scope || e.scope === "app"))) {
        delete cur.bindings[k];
      }
    });
    if (!Object.keys(cur.bindings).length) delete cur.bindings;
    if (isDefaultStoredObj(cur)) delete cfg[PREF_KEY];
    else cfg[PREF_KEY] = cur;

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

  // --- Linux session detection + GlobalShortcuts portal probe --------------

  function detectSessionRaw() {
    var env = process.env || {};
    var rawType = String(env.XDG_SESSION_TYPE || "").toLowerCase();
    var waylandDisplay = String(env.WAYLAND_DISPLAY || "");
    var display = String(env.DISPLAY || "");
    var useXwayland = env.CLAUDE_USE_XWAYLAND === "1";
    var isWayland = (rawType === "wayland" || (!rawType && !!waylandDisplay)) && !(useXwayland && !!display);
    var desktopRaw = String(env.XDG_CURRENT_DESKTOP || "");
    var desktop = desktopRaw;
    if (!desktop) {
      if (env.HYPRLAND_INSTANCE_SIGNATURE) desktop = "Hyprland";
      else if (env.SWAYSOCK) desktop = "sway";
      else if (env.KDE_FULL_SESSION) desktop = "KDE";
    }
    var upper = desktop.toUpperCase();
    var family = "other";
    if (upper.indexOf("KDE") >= 0 || upper.indexOf("PLASMA") >= 0) family = "kde";
    else if (upper.indexOf("GNOME") >= 0) family = "gnome";
    else if (upper.indexOf("HYPRLAND") >= 0) family = "hyprland";
    else if (upper.indexOf("SWAY") >= 0) family = "sway";
    else if (upper.indexOf("NIRI") >= 0) family = "niri";
    else if (upper.indexOf("RIVER") >= 0) family = "river";
    else if (upper.indexOf("XFCE") >= 0) family = "xfce";
    else if (upper.indexOf("I3") >= 0) family = "i3";

    return {
      sessionType: isWayland ? "wayland" : (useXwayland && waylandDisplay ? "xwayland" : "x11"),
      isWayland: isWayland,
      desktop: desktop || (isWayland ? "Wayland" : "X11"),
      family: family
    };
  }

  var portalState = {
    probed: false,
    available: null,
    version: 0,
    promise: null
  };

  function resolveBusctl() {
    try {
      if (globalThis.__cdbToolPath && typeof globalThis.__cdbToolPath.which === "function") {
        var found = globalThis.__cdbToolPath.which("busctl");
        if (found) return found;
      }
    } catch (e) {}
    return "busctl";
  }

  function probePortalOnce() {
    var sess = detectSessionRaw();
    if (!sess.isWayland) {
      portalState.probed = true;
      portalState.available = true;
      return Promise.resolve(portalState);
    }
    if (portalState.promise) return portalState.promise;
    portalState.promise = new Promise(function (resolve) {
      var bin = resolveBusctl();
      try {
        _cp.execFile(
          bin,
          [
            "--user",
            "--timeout=2",
            "get-property",
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.GlobalShortcuts",
            "version"
          ],
          { timeout: PORTAL_TIMEOUT_MS, encoding: "utf8", maxBuffer: 16 * 1024 },
          function (err, stdout) {
            portalState.probed = true;
            if (!err && stdout) {
              var m = /\bu\s+(\d+)/.exec(String(stdout));
              var ver = m ? Number(m[1]) : 0;
              portalState.version = ver;
              portalState.available = ver > 0;
            } else {
              portalState.version = 0;
              portalState.available = false;
            }
            resolve(portalState);
          }
        );
      } catch (e) {
        portalState.probed = true;
        portalState.available = false;
        resolve(portalState);
      }
    });
    return portalState.promise;
  }

  function sessionSummary() {
    var s = detectSessionRaw();
    var globalSupported = s.isWayland ? portalState.available === true : true;
    var note = "";
    if (!s.isWayland) {
      note = s.sessionType === "xwayland"
        ? "XWayland (" + s.desktop + ") - in-app shortcuts work, global shortcuts reach X11/XWayland windows; compositor binds work across native Wayland windows."
        : "X11 (" + s.desktop + ") - both in-app and global shortcuts work natively.";
    } else if (portalState.available === false) {
      note = "Wayland (" + s.desktop + ") - in-app shortcuts work; no GlobalShortcuts desktop portal here, so bind `claude-desktop --trigger-shortcut <action>` in your compositor for global hotkeys.";
    } else if (s.family === "hyprland") {
      note = "Wayland (Hyprland) - in-app shortcuts work; global hotkeys need a `global` or `exec, claude-desktop --trigger-shortcut <action>` bind in hyprland.conf.";
    } else if (s.family === "gnome") {
      note = "Wayland (GNOME) - in-app shortcuts work; global portal binds require approving the system prompt once (or bind `claude-desktop --trigger-shortcut <action>` in GNOME Settings -> Keyboard).";
    } else if (s.family === "kde") {
      note = "Wayland (KDE Plasma) - in-app and GlobalShortcuts portal shortcuts work (see System Settings -> Shortcuts if Plasma prompts).";
    } else {
      note = "Wayland (" + s.desktop + ") - in-app shortcuts work; global portal support depends on your compositor.";
    }
    return {
      sessionType: s.sessionType,
      isWayland: s.isWayland,
      desktop: s.desktop,
      family: s.family,
      portalProbed: portalState.probed,
      portalAvailable: s.isWayland ? portalState.available : null,
      portalVersion: portalState.version,
      globalSupported: globalSupported,
      note: note
    };
  }

  // --- Layout-aware before-input-event matching ----------------------------

  function matchesInput(parsed, input) {
    if (!parsed || !input || input.type !== "keyDown" || input.isAutoRepeat) return false;
    if (input.isComposing) return false;
    if (input.key === "AltGraph") return false;
    if (Array.isArray(input.modifiers) && input.modifiers.indexOf("altgr") >= 0) return false;

    if (!!input.control !== !!parsed.ctrl) return false;
    if (!!input.alt !== !!parsed.alt) return false;
    if (!!input.shift !== !!parsed.shift) return false;
    if (!!input.meta !== !!parsed.super) return false;

    var target = parsed.key;
    var key = typeof input.key === "string" ? input.key : "";
    var code = typeof input.code === "string" ? input.code : "";

    if (/^[A-Z]$/.test(target)) {
      // Latin letters match by produced character (QWERTZ 'Z', AZERTY 'A');
      // non-Latin active XKB groups (Cyrillic, Greek, ...) fall back to keycode.
      if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase() === target;
      return code === "Key" + target;
    }
    if (/^[0-9]$/.test(target)) {
      return code === "Digit" + target || (key === target && code.indexOf("Numpad") !== 0);
    }
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(target)) {
      return key.toUpperCase() === target || code.toUpperCase() === target;
    }
    if (/^num([0-9]|dec|add|sub|mult|div)$/.test(target)) {
      var numMap = {
        numdec: "NumpadDecimal",
        numadd: "NumpadAdd",
        numsub: "NumpadSubtract",
        nummult: "NumpadMultiply",
        numdiv: "NumpadDivide"
      };
      var expectedCode = numMap[target] || ("Numpad" + target.slice(3));
      return code === expectedCode;
    }
    if (target === "Space") return code === "Space" || key === " ";
    if (target === "Tab") return key === "Tab" || code === "Tab";
    if (target === "Backspace") return key === "Backspace" || code === "Backspace";
    if (target === "Delete") return key === "Delete" || code === "Delete";
    if (target === "Insert") return key === "Insert" || code === "Insert";
    if (target === "Return") return key === "Enter" || code === "Enter" || code === "NumpadEnter";
    if (target === "Up" || target === "Down" || target === "Left" || target === "Right") {
      return key === "Arrow" + target || code === "Arrow" + target || key === target;
    }
    if (target === "Home" || target === "End" || target === "PageUp" || target === "PageDown") {
      return key === target || code === target;
    }
    if (target === "Plus") {
      return key === "+" && code !== "NumpadAdd";
    }
    if (Object.prototype.hasOwnProperty.call(PUNCT_CODE, target)) {
      if (key === target) return true;
      // Only fall back to physical punctuation keycode for shifted ASCII variants
      // (e.g. Ctrl+Shift+- producing '_') or non-Latin keyboard layouts, never
      // when another distinct named punctuation char (e.g. QWERTZ '-' on Slash)
      // was produced.
      var shiftedVariant = !!input.shift && !NAMED_PUNCT.has(key) && !/^[a-zA-Z0-9+]$/.test(key);
      var nonLatin = key.length > 0 && key.charCodeAt(0) > 127;
      return (shiftedVariant || nonLatin) && code === PUNCT_CODE[target];
    }
    return false;
  }

  // --- Runtime state, globalShortcut sync, and page injection --------------

  var recordingUntil = 0;
  var recordingTimer = null;
  function isRecording() {
    if (!recordingUntil) return false;
    if (Date.now() > recordingUntil) { recordingUntil = 0; return false; }
    return true;
  }
  function setRecording(active) {
    if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
    var was = isRecording();
    recordingUntil = active ? (Date.now() + RECORDING_TTL_MS) : 0;
    if (active) {
      recordingTimer = setTimeout(function () {
        recordingTimer = null;
        recordingUntil = 0;
        syncGlobalShortcuts();
      }, RECORDING_TTL_MS + 50);
      if (recordingTimer && typeof recordingTimer.unref === "function") recordingTimer.unref();
    }
    if (isRecording() !== was) syncGlobalShortcuts();
  }

  var cachedConfig = readMergedConfig();
  var ownGlobalAccels = Object.create(null);   // actionId -> electronAccelerator currently registered by us
  var globalStatus = Object.create(null);      // actionId -> { registered: bool, reason?: string }
  var appReady = false;

  function unregisterOwnGlobals() {
    if (!_gs || typeof _gs.unregister !== "function") {
      ownGlobalAccels = Object.create(null);
      return;
    }
    Object.keys(ownGlobalAccels).forEach(function (id) {
      var accel = ownGlobalAccels[id];
      if (!accel) return;
      try { _gs.unregister(accel); } catch (e) {}
    });
    ownGlobalAccels = Object.create(null);
  }

  function syncGlobalShortcuts() {
    cachedConfig = readMergedConfig();
    var rec = isRecording();
    if (!appReady || !cachedConfig.enabled || rec) {
      unregisterOwnGlobals();
      globalStatus = Object.create(null);
      return;
    }

    var sess = detectSessionRaw();
    if (sess.isWayland && !portalState.probed) {
      probePortalOnce().then(function () { syncGlobalShortcuts(); });
      return;
    }
    var canPortal = !sess.isWayland || portalState.available === true;

    var desired = Object.create(null);
    var nextStatus = Object.create(null);

    ACTIONS.forEach(function (act) {
      var b = cachedConfig.bindings[act.id];
      if (!b || !b.accelerator || !b.parsed || b.scope !== "global") return;
      if (sess.isWayland && !canPortal) {
        nextStatus[act.id] = { registered: false, reason: "no-portal" };
        return;
      }
      if (!_gs || typeof _gs.register !== "function") {
        nextStatus[act.id] = { registered: false, reason: "unavailable" };
        return;
      }
      desired[act.id] = { accel: b.parsed.electron, label: b.accelerator };
    });

    // Unregister only removed or modified global bindings to avoid portal/KDE rebind churn.
    Object.keys(ownGlobalAccels).forEach(function (id) {
      var curAccel = ownGlobalAccels[id];
      var want = desired[id];
      if (!want || want.accel !== curAccel) {
        if (curAccel && _gs && typeof _gs.unregister === "function") {
          try { _gs.unregister(curAccel); } catch (e) {}
        }
        delete ownGlobalAccels[id];
      }
    });

    ACTIONS.forEach(function (act) {
      var want = desired[act.id];
      if (!want) return;
      if (ownGlobalAccels[act.id] === want.accel) {
        nextStatus[act.id] = { registered: true };
        return;
      }
      try {
        if (typeof _gs.isRegistered === "function" && _gs.isRegistered(want.accel)) {
          nextStatus[act.id] = { registered: false, reason: "in-use" };
          log("global shortcut already registered elsewhere: " + want.label + " (" + act.id + ")");
          return;
        }
        var ok = _gs.register(want.accel, function () {
          if (isRecording()) return;
          triggerAction(act.id, "global", null);
        });
        if (ok) {
          ownGlobalAccels[act.id] = want.accel;
          nextStatus[act.id] = { registered: true };
          log("registered global shortcut " + want.label + " -> " + act.id);
        } else {
          nextStatus[act.id] = { registered: false, reason: "registration-failed" };
          log("failed to register global shortcut " + want.label + " (" + act.id + ")");
        }
      } catch (e) {
        nextStatus[act.id] = { registered: false, reason: "error" };
        log("error registering global shortcut " + want.label + " (" + act.id + "): " + ((e && e.message) || e));
      }
    });

    globalStatus = nextStatus;
  }

  function findMainChatWebContents() {
    if (!_wc || typeof _wc.getAllWebContents !== "function") return null;
    var all = [];
    try { all = _wc.getAllWebContents(); } catch (e) { return null; }
    var eligible = [];
    for (var i = 0; i < all.length; i++) {
      var w = all[i];
      try {
        if (!w || w.isDestroyed()) continue;
        if (!isEligibleUrl(w.getURL() || "")) continue;
        eligible.push(w);
      } catch (e2) {}
    }
    if (!eligible.length) return null;
    // Prefer the webContents belonging to the currently focused BrowserWindow, if any.
    for (var j = 0; j < eligible.length; j++) {
      try {
        var win = _bw && typeof _bw.fromWebContents === "function" ? _bw.fromWebContents(eligible[j]) : null;
        if (win && !win.isDestroyed() && win.isFocused()) return eligible[j];
      } catch (e3) {}
    }
    return eligible[0];
  }

  function ensureWindowFocused(wc) {
    try {
      if (!_bw || typeof _bw.fromWebContents !== "function" || !wc || wc.isDestroyed()) return;
      var win = _bw.fromWebContents(wc);
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      if (typeof wc.focus === "function") wc.focus();
    } catch (e) {}
  }

  function injectIntoWebContents(wc) {
    try {
      if (!wc || wc.isDestroyed()) return;
      if (!isEligibleUrl(wc.getURL() || "")) return;
      var p = wc.executeJavaScript(PAGE_SRC);
      if (p && typeof p.catch === "function") {
        p.catch(function (err) {
          log("page script injection failed: " + ((err && err.message) || String(err)));
        });
      }
    } catch (e) {}
  }

  function injectIntoAllEligibleWebContents() {
    if (!_wc || typeof _wc.getAllWebContents !== "function") return;
    try {
      var all = _wc.getAllWebContents();
      for (var i = 0; i < all.length; i++) {
        injectIntoWebContents(all[i]);
      }
    } catch (e) {}
  }

  function triggerAction(actionIdOrSlug, source, targetWc) {
    var act = lookupActionAny(actionIdOrSlug);
    if (!act) {
      log("trigger ignored: unknown action " + String(actionIdOrSlug || ""));
      return Promise.resolve({ ok: false, error: "unknown shortcut action" });
    }
    var cfg = readMergedConfig();
    cachedConfig = cfg;
    if (!cfg.enabled) {
      log("trigger refused (" + act.id + "): custom shortcuts are disabled");
      return Promise.resolve({
        ok: false,
        action: act.id,
        error: "Custom shortcuts are disabled (enable them in Settings -> Extra -> Custom Shortcuts)"
      });
    }
    log("trigger action=" + act.id + " source=" + String(source || "unknown"));

    var wc = (targetWc && !targetWc.isDestroyed() && isEligibleUrl(targetWc.getURL() || ""))
      ? targetWc
      : findMainChatWebContents();
    if (!wc) {
      log("trigger failed (" + act.id + "): no active chat webContents");
      return Promise.resolve({ ok: false, action: act.id, error: "no active Claude window" });
    }

    if ((source === "global" || source === "socket" || source === "cli" || source === "second-instance") && act.focusWindow) {
      ensureWindowFocused(wc);
    }

    var navigatedByMain = false;
    if (act.id === "newVoiceChat") {
      try {
        var curPath = new _URL(wc.getURL() || "").pathname;
        if (curPath !== "/new" && curPath !== "/") {
          var nav = globalThis.__cdbNavigation;
          var disp = nav && typeof nav.getDispatcher === "function" ? nav.getDispatcher(wc) : null;
          if (disp && typeof disp.dispatchNavigate === "function") {
            disp.dispatchNavigate("/new");
            navigatedByMain = true;
          }
        }
      } catch (e) {}
    }

    var callArgs = JSON.stringify({ navigatedByMain: navigatedByMain });
    var expr = "(function(){return window.__cdbCustomShortcuts && " +
      "typeof window.__cdbCustomShortcuts.trigger==='function' ? " +
      "window.__cdbCustomShortcuts.trigger(" + JSON.stringify(act.id) + "," + callArgs + ") : " +
      "{ok:false,reason:'page-helper-missing'};})()";

    return wc.executeJavaScript(expr).then(function (res) {
      if (res && res.reason === "page-helper-missing") {
        // Re-inject once and retry if a freshly loaded view had not finished injection yet.
        return wc.executeJavaScript(PAGE_SRC).then(function () {
          return wc.executeJavaScript(expr);
        });
      }
      return res;
    }).catch(function (err) {
      var msg = (err && err.message) || String(err);
      log("trigger execution failed (" + act.id + "): " + msg);
      return { ok: false, action: act.id, error: msg };
    });
  }

  // Build state payload handed to Settings -> Extra -> Custom Shortcuts.
  function statePayload() {
    var cfg = readMergedConfig();
    var sess = sessionSummary();
    var activeCount = 0;
    var boundCount = 0;
    var items = ACTIONS.map(function (act) {
      var b = cfg.bindings[act.id];
      var gs = Object.prototype.hasOwnProperty.call(globalStatus, act.id) ? globalStatus[act.id] : null;
      if (b.accelerator) boundCount++;
      if (cfg.enabled && b.accelerator) activeCount++;
      return {
        id: act.id,
        slug: act.slug,
        title: act.title,
        description: act.description,
        accelerator: b.accelerator,
        scope: b.scope,
        locked: b.locked,
        globalStatus: gs
      };
    });
    return {
      ok: true,
      enabled: cfg.enabled,
      enabledLocked: cfg.enabledLocked,
      lockedByJsonc: cfg.lockedByJsonc,
      source: cfg.enabledSource,
      activeCount: activeCount,
      boundCount: boundCount,
      actions: items,
      session: sess,
      cliFlag: "--trigger-shortcut"
    };
  }

  function globalConflictWarning(id, accel) {
    var gs = Object.prototype.hasOwnProperty.call(globalStatus, id) ? globalStatus[id] : null;
    if (!gs || gs.registered) return "";
    if (gs.reason === "in-use" || gs.reason === "registration-failed") {
      return "Saved, but desktop global shortcut registration was refused (another app may hold \"" +
        accel + "\"). In-app trigger still works.";
    }
    return "";
  }

  // --- IPC handlers --------------------------------------------------------

  var handlers = {
    "cdb-shortcuts:pref-read": function () {
      return statePayload();
    },
    "cdb-shortcuts:pref-set": function (enabled) {
      var cfg = readMergedConfig();
      if (cfg.enabledLocked) {
        return { ok: false, error: "customShortcuts.enabled is set in claude-desktop-extra.jsonc" };
      }
      var nextEnabled = enabled === true;
      var res = mutateJsonConfig(function (cur) {
        cur.enabled = nextEnabled;
        return null;
      });
      if (!res.ok) return res;
      syncGlobalShortcuts();
      if (nextEnabled) injectIntoAllEligibleWebContents();
      return statePayload();
    },
    "cdb-shortcuts:bind": function (actionId, rawAccel) {
      var id = String(actionId || "");
      var act = lookupAction(id);
      if (!act) return { ok: false, error: "Unknown shortcut action" };

      var cfg = readMergedConfig();
      if (cfg.bindings[id] && cfg.bindings[id].locked) {
        return { ok: false, error: act.title + " is set in claude-desktop-extra.jsonc" };
      }

      var parsed = parseAccelerator(rawAccel);
      if (!parsed.ok) return { ok: false, error: parsed.error };

      if (!parsed.empty) {
        for (var i = 0; i < ACTIONS.length; i++) {
          var other = ACTIONS[i];
          if (other.id === id) continue;
          if (cfg.bindings[other.id].accelerator === parsed.canonical) {
            return {
              ok: false,
              error: "\"" + parsed.canonical + "\" is already assigned to " + other.title
            };
          }
        }
      }

      var res = mutateJsonConfig(function (cur) {
        var prev = cur.bindings[id] && typeof cur.bindings[id] === "object" ? cur.bindings[id] : {};
        if (parsed.empty) {
          delete prev.accelerator;
          if (prev.scope && prev.scope !== "app") cur.bindings[id] = prev;
          else delete cur.bindings[id];
        } else {
          cur.bindings[id] = { accelerator: parsed.canonical, scope: prev.scope === "global" ? "global" : "app" };
          if (cur.enabled === undefined && !cfg.enabledLocked) {
            cur.enabled = true;
          }
        }
        return null;
      });
      if (!res.ok) return res;

      syncGlobalShortcuts();
      var afterCfg = readMergedConfig();
      if (!parsed.empty && afterCfg.enabled) injectIntoAllEligibleWebContents();
      if (!parsed.empty && afterCfg.enabled && afterCfg.bindings[id] && afterCfg.bindings[id].scope === "global") {
        var warn = globalConflictWarning(id, parsed.canonical);
        if (warn) return Object.assign(statePayload(), { warning: warn });
      }
      return statePayload();
    },
    "cdb-shortcuts:scope": function (actionId, rawScope) {
      var id = String(actionId || "");
      var act = lookupAction(id);
      if (!act) return { ok: false, error: "Unknown shortcut action" };
      var scope = rawScope === "global" ? "global" : (rawScope === "app" ? "app" : null);
      if (!scope) return { ok: false, error: "Invalid scope" };

      var cfg = readMergedConfig();
      if (cfg.bindings[id] && cfg.bindings[id].locked) {
        return { ok: false, error: act.title + " is set in claude-desktop-extra.jsonc" };
      }

      var res = mutateJsonConfig(function (cur) {
        var prev = cur.bindings[id] && typeof cur.bindings[id] === "object" ? cur.bindings[id] : {};
        cur.bindings[id] = {
          accelerator: typeof prev.accelerator === "string" ? prev.accelerator : "",
          scope: scope
        };
        return null;
      });
      if (!res.ok) return res;
      syncGlobalShortcuts();
      var afterCfg = readMergedConfig();
      if (scope === "global" && afterCfg.enabled && afterCfg.bindings[id] && afterCfg.bindings[id].accelerator) {
        var warn = globalConflictWarning(id, afterCfg.bindings[id].accelerator);
        if (warn) return Object.assign(statePayload(), { warning: warn });
      }
      return statePayload();
    },
    "cdb-shortcuts:reset": function () {
      var res = mutateJsonConfig(function (cur) {
        ACTIONS.forEach(function (act) {
          delete cur.bindings[act.id];
        });
        return null;
      });
      if (!res.ok) return res;
      syncGlobalShortcuts();
      return statePayload();
    },
    "cdb-shortcuts:recording": function (active) {
      setRecording(active === true);
      return { ok: true, recording: isRecording() };
    }
  };

  try {
    if (_ipc) {
      Object.keys(handlers).forEach(function (ch) {
        try { _ipc.removeHandler(ch); } catch (e) {}
        _ipc.handle(ch, function (ev) {
          if (!okSender(ev)) {
            return { ok: false, error: "Untrusted IPC sender" };
          }
          var args = Array.prototype.slice.call(arguments, 1);
          try {
            return handlers[ch].apply(null, args);
          } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
          }
        });
      });
    }
  } catch (e) {
    log("IPC registration failed: " + ((e && e.message) || e));
  }

  // --- Electron lifecycle wiring -------------------------------------------

  try {
    if (_app && typeof _app.on === "function") {
      _app.on("web-contents-created", function (_ev, wc) {
        wc.on("dom-ready", function () {
          var cfg = cachedConfig;
          if (!cfg || !cfg.enabled) return;
          injectIntoWebContents(wc);
        });
        wc.on("before-input-event", function (ev, input) {
          try {
            var cfg = cachedConfig;
            if (!cfg || !cfg.enabled || isRecording()) return;
            if (!wc || wc.isDestroyed() || !isEligibleUrl(wc.getURL() || "")) return;
            for (var i = 0; i < ACTIONS.length; i++) {
              var act = ACTIONS[i];
              var b = cfg.bindings[act.id];
              if (!b || !b.parsed) continue;
              if (matchesInput(b.parsed, input)) {
                ev.preventDefault();
                triggerAction(act.id, "in-app", wc);
                return;
              }
            }
          } catch (e) {}
        });
      });

      _app.on("will-quit", function () {
        if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }
        unregisterOwnGlobals();
      });

      if (typeof _app.whenReady === "function") {
        _app.whenReady().then(function () {
          probePortalOnce().then(function () {
            appReady = true;
            syncGlobalShortcuts();
          });
        }, function () {});
      }
    }
  } catch (e) {
    log("lifecycle wiring failed: " + ((e && e.message) || e));
  }

  globalThis.__cdbCustomShortcuts = Object.freeze({
    trigger: function (id, src) {
      return triggerAction(id, src || "cli", null);
    },
    _parseAccelerator: parseAccelerator,
    _matchesInput: matchesInput,
    _syncGlobalShortcuts: syncGlobalShortcuts,
    _statePayload: statePayload
  });

  log("custom shortcuts module initialized");
})();
