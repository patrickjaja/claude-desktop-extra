/* Native session-start consent. No CLI rule or child-session permission is written. */
(function () {
  "use strict";
  return async function sessionStartPermission(input, signal, eligible) {
    var store = globalThis.__cdbSessionStartPermission;
    if (process.platform !== "linux" || !store || typeof eligible !== "function") return;
    var answered = false;
    try {
      if (!await eligible()) return;
      if (signal && signal.aborted) return { behavior: "deny", message: "Request aborted" };
      if (store.read()) return { behavior: "allow", updatedInput: input };
      var revision = store.revision;
      var electron = require("electron");
      var answer = await electron.dialog.showMessageBox({
        type: "question",
        title: "Session start permission",
        message: "Allow Claude to start another session?",
        detail: JSON.stringify(input, null, 2) + "\n\nAlways allow saves this choice for this Desktop profile. It only covers starting sessions, not actions inside them. Organization, host and destination restrictions still apply. Revoke under Settings → Extra → Community.",
        buttons: ["Deny", "Allow once", "Allow always"],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        ...(signal ? { signal: signal } : {})
      });
      answered = true;
      if ((signal && signal.aborted) || store.revision !== revision) {
        return { behavior: "deny", message: "Session-start approval was cancelled or revoked. Nothing was started." };
      }
      if (answer.response !== 1 && answer.response !== 2) {
        return { behavior: "deny", message: "User rejected starting another session.", interrupt: false };
      }
      // Re-read the host's rules after the person answers. A changed policy must
      // not fall through to a card carrying the old, now-stale approval reason.
      if (!await eligible()) {
        return { behavior: "deny", message: "Session-start policy or destination changed while awaiting approval. Nothing was started. Call the tool again for a fresh approval." };
      }
      if ((signal && signal.aborted) || store.revision !== revision) {
        return { behavior: "deny", message: "Session-start approval was cancelled or revoked. Nothing was started." };
      }
      if (answer.response === 2) {
        var saved = store.grant();
        if (!saved || saved.ok !== true) {
          return { behavior: "deny", message: "The permanent session-start permission could not be saved. Nothing was started; choose Allow once to continue." };
        }
      }
      return { behavior: "allow", updatedInput: input };
    } catch (error) {
      // An unavailable store/dialog/host-policy check must never approve a call.
      try { globalThis.__cdbDiag?.("[session-start-permission] " + String(error)); } catch (_) {}
      if (answered) return { behavior: "deny", message: "The session-start approval could not be revalidated or saved. Nothing was started. Call the tool again for a fresh approval." };
      return;
    }
  };
})()
