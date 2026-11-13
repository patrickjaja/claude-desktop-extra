;/*__CDB_JIRA_SEND__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  var WORKTREE_FROM_START = true;
  var NAVIGATE_TO_SESSION = true;
  var START_ATTENDED = true;
  var ACTIONS = ["implement"];
  var KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
  var GIT_TIMEOUT_MS = 5000;

  var CONFIRM_SHOWN = 2000;

  function message(e) { return String((e && e.message) || e || "unknown error").slice(0, 500); }

  function shownText(text) {
    if (text.length <= CONFIRM_SHOWN) return text;
    var cut = CONFIRM_SHOWN, code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    return text.slice(0, cut) + "\n... (" + (text.length - cut) + " more characters)";
  }
  function confirmDetail(text, folder, mode) {
    return "Folder: " + folder + "\n" +
      "The session runs in your default permission mode" + (mode ? " (" + mode + ")" : "") + ".\n" +
      "The ticket text comes from Jira and can be written by anyone who can edit the ticket.\n\n" +
      "First message:\n\n" + shownText(text);
  }

  function isGitWorkTree(execFile, folder) {
    function run(args) {
      return new Promise(function (resolve) {
        try {
          execFile("git", ["-C", folder].concat(args), { timeout: GIT_TIMEOUT_MS, windowsHide: true }, function (err, stdout) {
            resolve(err ? null : String(stdout || "").trim());
          });
        } catch (e) { resolve(null); }
      });
    }
    return run(["rev-parse", "--is-inside-work-tree"]).then(function (inside) {
      if (inside !== "true") return false;
      return run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).then(function (head) { return !!head; });
    });
  }

  function create(deps) {
    var log = deps.log || function () {};
    var busy = false;

    function box(win, opts) {
      return Promise.resolve(win ? deps.dialog.showMessageBox(win, opts) : deps.dialog.showMessageBox(opts))
        .then(function (r) { return !!r && r.response === 1; }, function () { return false; });
    }
    async function activeIn(manager, folder) {
      if (typeof manager.getAllSessions !== "function") return false;
      try {
        var all = await manager.getAllSessions();
        return (Array.isArray(all) ? all : []).some(function (s) { return !!s && !s.isArchived && (s.originCwd || s.cwd) === folder; });
      } catch (e) { return false; }
    }
    async function defaultMode(manager, folder) {
      if (typeof manager.getDefaultPermissionMode !== "function") return "";
      try {
        var mode = await manager.getDefaultPermissionMode(folder);
        return typeof mode === "string" ? mode : "";
      } catch (e) { return ""; }
    }

    async function run(req) {
      if (!req || !KEY_RE.test(String(req.key)) || ACTIONS.indexOf(req.action) < 0) return { ok: false, error: "bad request" };
      var creds = deps.store.creds();
      if (!creds) return { ok: false, error: "Jira is not set up." };
      var fresh = await deps.client.issue(creds, req.key);
      if (!fresh.ok) return { ok: false, error: fresh.message };
      var rec = fresh.record, st = deps.store.state(), win = deps.window();
      var last = (rec.project && st.folders[rec.project]) || "";
      var pickOpts = { title: "Folder for " + rec.key, properties: ["openDirectory"] };
      if (last) pickOpts.defaultPath = last;
      var pick = await (win ? deps.dialog.showOpenDialog(win, pickOpts) : deps.dialog.showOpenDialog(pickOpts));
      if (!pick || pick.canceled || !Array.isArray(pick.filePaths) || !pick.filePaths[0]) return { ok: false, cancelled: true };
      if (!deps.enabled()) return { ok: false, error: "The Jira tracker was switched off." };
      var folder;
      try {
        folder = await deps.fs.promises.realpath(pick.filePaths[0]);
        if (!(await deps.fs.promises.stat(folder)).isDirectory()) throw new Error("not a directory");
      } catch (e) { return { ok: false, error: "The chosen folder cannot be used." }; }
      var manager = await deps.getManager();
      if (!manager || typeof manager.startSession !== "function" || typeof manager.checkWorkspaceTrust !== "function") {
        log("send: session manager missing");
        return { ok: false, error: "This build cannot start Code sessions from the Jira page." };
      }
      var trust = await manager.checkWorkspaceTrust(folder);
      if (!trust || trust.trusted !== true) {
        var yes = await box(win, { type: "question", title: "Trust this folder?", message: "Start a Code session for " + rec.key + " in " + folder + "?",
          detail: "This folder is not trusted yet. The session can read and change files in it and run commands there, with your default permission mode.",
          buttons: ["Cancel", "Trust and start"], defaultId: 0, cancelId: 0, noLink: true });
        if (!yes) return { ok: false, cancelled: true };
        if (!deps.enabled()) return { ok: false, error: "The Jira tracker was switched off." };
        await manager.saveWorkspaceTrust(folder);
      }
      var useWorktree = WORKTREE_FROM_START ? await deps.gitWorkTree(folder) : false;
      if (!WORKTREE_FROM_START && await activeIn(manager, folder)) {
        var share = await box(win, { type: "warning", title: "Folder already in use", message: "Another session already works in " + folder + ".",
          detail: "Both sessions would share one checkout.", buttons: ["Cancel", "Start anyway"], defaultId: 0, cancelId: 0, noLink: true });
        if (!share) return { ok: false, cancelled: true };
      }
      var text = deps.prompt.fill(st.template, { key: rec.key, summary: rec.summary, url: rec.url, type: rec.type, priority: rec.priority,
        description: deps.adf.toMarkdown(fresh.description, deps.adf.LIMIT) });
      var options = { cwd: folder, message: text, title: (rec.key + ": " + rec.summary).slice(0, 200) };
      if (useWorktree) options.useWorktree = true;
      var mode = await defaultMode(manager, folder);
      if (mode) options.permissionMode = mode;
      // The ticket text is untrusted: show the exact first message before every send.
      var go = await box(win, { type: "question", title: "Send " + rec.key + " to a Code session?", message: "Start a Code session for " + rec.key + " in " + folder + "?",
        detail: confirmDetail(text, folder, mode), buttons: ["Cancel", "Start session"], defaultId: 0, cancelId: 0, noLink: true });
      if (!go) return { ok: false, cancelled: true };
      if (!deps.enabled()) return { ok: false, error: "The Jira tracker was switched off." };
      var startOpts = START_ATTENDED ? { initiator: "user" } : { origin: { kind: "auto-continuation" }, initiator: "jira-tracker" };
      var sessionId;
      try { sessionId = await manager.startSession(options, startOpts); }
      catch (e) { log("send: start refused"); return { ok: false, error: message(e) }; }
      if (rec.project) deps.store.stateWrite({ folder: { project: rec.project, path: folder } });
      deps.closeTracker();
      var route = "";
      try { route = NAVIGATE_TO_SESSION && typeof manager.getSessionRoute === "function" ? String(manager.getSessionRoute(sessionId) || "") : ""; } catch (e) { route = ""; }
      if (!route || !deps.navigate(route)) deps.notify("Started " + rec.key + " in " + folder);
      log("send: started (worktree=" + useWorktree + ", navigated=" + !!route + ")");
      return { ok: true, sessionId: String(sessionId) };
    }

    async function send(req) {
      if (busy) return { ok: false, error: "A send is already running." };
      busy = true;
      try { return await run(req); }
      catch (e) { log("send: failed"); return { ok: false, error: message(e) }; }
      finally { busy = false; }
    }

    return { send: send, busy: function () { return busy; } };
  }

  globalThis.__cdbJiraSendFactory = create;
  globalThis.__cdbJiraIsGitWorkTree = isGitWorkTree;
  globalThis.__cdbJiraSendConstants = { WORKTREE_FROM_START: WORKTREE_FROM_START, NAVIGATE_TO_SESSION: NAVIGATE_TO_SESSION, START_ATTENDED: START_ATTENDED };
})();
