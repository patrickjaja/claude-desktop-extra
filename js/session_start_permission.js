/* Native dialog with "Allow always" for starting other sessions (opt-in).
 * Runs at the broker's ordinary card sink for mcp__ccd_session__start_session.
 * Returning undefined leaves upstream's own in-chat card in charge; that is the
 * answer for the switch being off, anything ineligible, no visible app window,
 * and every failure before the person answered. After an answer, a failure
 * denies. No CLI rule or child-session permission is ever written. */
(function () {
  "use strict";
  // Upstream's own ranking (kR next to permission_mode's enum); an unknown mode
  // never qualifies for a remembered approval.
  var MODE_RANK = { plan: 0, "default": 1, dontAsk: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };
  var PLACE_FIELDS = ["host", "environment", "preset", "repository"];

  function destination(input) {
    if (input.cwd === undefined) return;
    if (typeof input.cwd !== "string" || !input.cwd.startsWith("/") ||
        input.cwd.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.cwd)) throw Error("Invalid local destination");
    var fs = require("fs");
    var resolved = fs.realpathSync(input.cwd);
    if (!fs.statSync(resolved).isDirectory()) throw Error("Destination is not a directory");
    return resolved;
  }

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  // The asking session's project, the way upstream names it for start targets
  // (originCwd || cwd), on this computer only. undefined = no remembered scope.
  function projectKey(session) {
    if (!session || typeof session !== "object") return;
    if (session.sshConfig || session.wslConfig) return;
    if (session.backend && session.backend.remoteTarget !== undefined) return;
    var dir = session.originCwd || session.cwd;
    if (typeof dir !== "string" || dir.charAt(0) !== "/" || dir.length > 4096) return;
    var key = require("path").posix.normalize(dir);
    if (key.length > 1 && key.charAt(key.length - 1) === "/") key = key.slice(0, -1);
    return key;
  }

  // A request a remembered approval may cover: the default destination of this
  // project, at this session's permission mode or lower.
  function inScope(input, session) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    for (var i = 0; i < PLACE_FIELDS.length; i++) {
      if (has(input, PLACE_FIELDS[i]) && input[PLACE_FIELDS[i]] !== undefined) return false;
    }
    if (input.target !== undefined && input.target !== "local") return false;
    if (input.permission_mode === undefined) return true;
    var parent = session && session.permissionMode;
    var child = input.permission_mode;
    if (typeof child !== "string" || !has(MODE_RANK, child) || typeof parent !== "string" || !has(MODE_RANK, parent)) return false;
    if (MODE_RANK[child] > MODE_RANK[parent]) return false;
    // dontAsk ranks with default but refuses instead of asking: only from dontAsk.
    if (child === "dontAsk" && parent !== "dontAsk") return false;
    return true;
  }

  // Every Code session's card is rendered in the main window's claude.ai view,
  // so that window is the dialog's parent. Hidden, minimized or gone: no dialog.
  function sessionWindow(getMainWindow) {
    var win;
    try { win = typeof getMainWindow === "function" ? getMainWindow() : undefined; } catch (e) { return; }
    if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return;
    if (typeof win.isVisible !== "function" || !win.isVisible()) return;
    if (typeof win.isMinimized === "function" && win.isMinimized()) return;
    return win;
  }

  function clip(text, max) {
    var chars = Array.from(String(text));
    return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
  }

  function oneLine(value, max) {
    return typeof value === "string" && value.trim() ? clip(value.replace(/\s+/g, " ").trim(), max) : undefined;
  }

  function describe(input, session, sessionId, key, target, place) {
    var title = oneLine(input.title, 120);
    var from = oneLine(session && session.title, 120) || String(sessionId);
    var lines = [];
    lines.push("Asked by: " + from);
    lines.push("Project: " + key);
    lines.push(target === undefined
      ? "Destination: this project, " + (input.use_worktree === false ? "sharing this session's checkout" : "its default checkout or worktree")
      : "Destination directory: " + target);
    if (place) lines.push("", place.sentence);
    lines.push("Permission mode: " + (typeof input.permission_mode === "string"
      ? oneLine(input.permission_mode, 40)
      : "this session's (" + (oneLine(session && session.permissionMode, 40) || "unknown") + ")"));
    if (oneLine(input.model, 80)) lines.push("Model: " + oneLine(input.model, 80));
    if (oneLine(input.effort, 40)) lines.push("Effort: " + oneLine(input.effort, 40));
    var prompt = typeof input.prompt === "string" && input.prompt.trim() ? clip(input.prompt.trim(), 300) : "(none)";
    lines.push("", "Prompt Claude wrote:", prompt, "",
      (target === undefined
        ? "\"Allow always\" remembers this for THIS project and the default destination only. "
        : "\"Allow always\" remembers this for THIS asking project and ONLY the destination directory shown above, and only skips this dialog for later asks about that same pair while the app is running and the asking session stays the same. A new asking session or an app restart asks again for the folder. It does not trust other folders. ") +
      "Sessions started this way run in this session's permission mode (or a lower one) from a prompt Claude wrote; " +
      "nothing inside them is approved by this. Turn it off or forget remembered approvals under " +
      "Settings -> Extra -> Community Features.");
    return {
      title: "Start another session?",
      message: title ? "Claude wants to start the session \"" + title + "\"" : "Claude wants to start another session",
      detail: lines.join("\n")
    };
  }

  // One diagnostic line when an eligible-looking ask keeps upstream's card.
  // Fixed tokens only: no path, prompt or id.
  function keep(reason) {
    try { globalThis.__cdbDiag?.("[session-start-always-allow] card kept: " + reason); } catch (e) {}
  }

  return async function sessionStartAlwaysAllow(input, signal, eligible, ctx) {
    // FIRST: the switch. Off means upstream's card, stored grants or not.
    var enabled = globalThis.__cdbSessionStartDialogEnabled;
    try {
      if (process.platform !== "linux" || typeof enabled !== "function" || enabled() !== true) return;
    } catch (e0) { return; }
    var store = globalThis.__cdbSessionStartPermission;
    if (!store || typeof eligible !== "function" || !ctx) return;
    var answered = false;
    try {
      // eligible() logs its own refusal; the recheck below passes true to stay quiet.
      if (!await eligible()) return;
      var session = ctx.session;
      var key = projectKey(session);
      if (key === undefined) { keep("scope:project"); return; }
      if (!inScope(input, session)) { keep("scope:input"); return; }
      var target = destination(input);
      var grantKey = target === undefined ? key : JSON.stringify([key, target]);
      var place = typeof ctx.place === "function" ? await ctx.place() : undefined;
      // A first-use destination still needs visible consent, even if an older
      // remembered start exists. Only the real dialog may stamp that consent.
      if (signal && signal.aborted) return { behavior: "deny", message: "Request aborted" };
      if (!place && store.has(grantKey) === true) {
        if (destination(input) !== target || projectKey(ctx.session) !== key || enabled() !== true) {
          return { behavior: "deny", message: "The remembered session-start destination changed. Nothing was started." };
        }
        return { behavior: "allow", updatedInput: input };
      }
      var win = sessionWindow(ctx.mainWindow);
      if (!win) { keep("window"); return; }
      var revision = store.revision;
      var text = describe(input, session, ctx.sessionId, key, target, place);
      win.show();
      win.focus();
      var answer = await require("electron").dialog.showMessageBox(win, {
        type: "question",
        title: text.title,
        message: text.message,
        detail: text.detail,
        buttons: ["Deny", "Allow once", "Allow always"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        ...(signal ? { signal: signal } : {})
      });
      answered = true;
      var stale = function () {
        return (signal && signal.aborted) || store.revision !== revision || enabled() !== true;
      };
      if (stale()) {
        return { behavior: "deny", message: "Session-start approval was cancelled, revoked or switched off. Nothing was started." };
      }
      if (!answer || (answer.response !== 1 && answer.response !== 2)) {
        return { behavior: "deny", message: "User rejected starting another session.", interrupt: false };
      }
      // Re-read the host's rules after the person answers: a changed policy must
      // not fall through to a card carrying the old, now-stale approval reason.
      if (!await eligible(true)) {
        return { behavior: "deny", message: "Session-start policy or destination changed while awaiting approval. Nothing was started. Call the tool again for a fresh approval." };
      }
      if (stale()) {
        return { behavior: "deny", message: "Session-start approval was cancelled, revoked or switched off. Nothing was started." };
      }
      var currentPlace = typeof ctx.place === "function" ? await ctx.place() : undefined;
      if (destination(input) !== target || projectKey(ctx.session) !== key ||
          JSON.stringify(currentPlace) !== JSON.stringify(place) || stale() || !inScope(input, ctx.session)) {
        return { behavior: "deny", message: "The session-start destination or consent changed. Nothing was started; request fresh approval." };
      }
      if (answer.response === 2) {
        var saved = store.grant(grantKey);
        if (!saved || saved.ok !== true) {
          return { behavior: "deny", message: "The remembered session-start approval could not be saved. Nothing was started; choose Allow once to continue." };
        }
      }
      var result = { behavior: "allow", updatedInput: input };
      if (typeof ctx.onApproved === "function") ctx.onApproved(result);
      return result;
    } catch (error) {
      // An unavailable store, window, dialog or host-policy check never approves.
      try { globalThis.__cdbDiag?.("[session-start-always-allow] " + String(error)); } catch (_) {}
      if (answered) return { behavior: "deny", message: "The session-start approval could not be revalidated or saved. Nothing was started. Call the tool again for a fresh approval." };
      return;
    }
  };
})()
