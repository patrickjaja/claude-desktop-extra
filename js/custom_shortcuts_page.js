/*
 * custom_shortcuts_page.js - page-side action executor for Custom Shortcuts
 * (issues #350, #352).
 *
 * Embedded by patches/community/add_feature_custom_shortcuts.nim into
 * js/custom_shortcuts_main.js and executed via webContents.executeJavaScript()
 * on claude.ai / claude.com / app://localhost (non-setup) views that carry
 * window.cdbExtra.
 *
 * Exposes window.__cdbCustomShortcuts:
 *   trigger(actionId, opts)      -> Promise<{ ok, action, detail?, reason? }>
 *   isRecordingShortcut()        -> boolean
 *   state()                      -> diagnostic snapshot
 *
 * Anchors (derived from ion-dist 5.11492.5, Code tab Read Aloud from 6.28899.6;
 * inventoried in baseline/CUSTOM_SHORTCUTS_ANCHORS.md):
 *   - Read Aloud:
 *       [data-testid="assistant-message"][data-is-streaming][data-turn-key]
 *       [data-testid="action-bar-read-aloud"][data-state]          (Chat)
 *       [data-testid="epitaxy-read-aloud"] + fiber { playing, label } (Code tab)
 *       [data-testid="message-actions"][data-deferred],
 *       [data-cds="MessageActions"][data-deferred]
 *       Code tab: the newest turn's actions are portaled into
 *       [data-testid="transcript-tail-actions"][data-transcript-last-row-controls]
 *       inside [data-transcript-tail-turn]; owned when the reply's
 *       data-turn-key equals the fiber turn.key or messageUuid (the entry
 *       id) found in it. Streaming is judged per data-turn-key.
 *   - Voice Mode:
 *       button[aria-label="Use voice mode"]
 *       React fiber props: qR ({ state, onStart, onEnd, onCancel, onToggleMute }),
 *       xR ({ onPrimaryClick, items })
 *   - Send Now (queued messages):
 *       button[data-testid="awaiting-turn-send-now"]
 *       React fiber props: onSendNow / onSendNowChord
 *   - Recording guard:
 *       [data-keyboard-shortcut-input]
 *
 * Every missing anchor degrades cleanly to a short floating notice and a
 * deduped [cdb-shortcuts] warning (console.warn + cdbExtra.diag) — never throws.
 */
(function () {
  "use strict";

  if (window.__cdbCustomShortcuts && window.__cdbCustomShortcuts._installed) {
    return "custom-shortcuts: already installed";
  }

  var api = window.cdbExtra;
  if (!api || typeof api.diag !== "function") {
    return "custom-shortcuts: skipped, no cdbExtra in this view";
  }

  var SETTINGS_DIALOG_SEL = '[role="dialog"]';
  var ASSISTANT_MSG_SEL = '[data-testid="assistant-message"]';
  // Chat: action-bar-read-aloud (data-state). Code tab: epitaxy-read-aloud
  // (no data-state; label Read aloud / Pause / Resume, fiber prop "playing").
  var READ_ALOUD_SEL = '[data-testid="action-bar-read-aloud"], [data-testid="epitaxy-read-aloud"]';
  var DEFERRED_ACTIONS_SEL =
    '[data-testid="message-actions"][data-deferred], [data-cds="MessageActions"][data-deferred]';
  var ACTIONS_BOX_SEL = '[data-testid="message-actions"], [data-cds="MessageActions"]';
  // Code tab: upstream portals the NEWEST turn's message actions out of its
  // assistant-message into this outlet below the transcript rows, after any
  // turn box / approval / question card of the transcript tail.
  var TAIL_ACTIONS_SEL = '[data-testid="transcript-tail-actions"], [data-transcript-last-row-controls]';
  var TAIL_TURN_SEL = "[data-transcript-tail-turn]";
  var TRANSCRIPT_ROOT_SEL = '[data-testid="epitaxy-virtual-transcript"], [role="feed"]';
  var VOICE_BTN_SEL = 'button[aria-label="Use voice mode"]';
  var SEND_NOW_SEL = 'button[data-testid="awaiting-turn-send-now"]';
  var RECORDING_INPUT_SEL = "[data-keyboard-shortcut-input]";

  var MAX_FIBER_HOPS = 25;
  var DEFERRED_WAIT_FRAMES = 18;
  var NEW_CHAT_POLL_MS = 60;
  var NEW_CHAT_TIMEOUT_MS = 4500;
  var VOICE_MISTAP_SETTLE_MS = 400;

  var warned = {};
  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    var line = "[cdb-shortcuts] " + key + ": " + msg;
    try { console.warn(line); } catch (e) {}
    try { api.diag(line); } catch (e2) {}
  }

  var toastEl = null;
  var toastTimer = null;
  function showNotice(text, isError) {
    try {
      if (!document.body) return;
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement("div");
        toastEl.className = "cdb-sc-toast";
        toastEl.setAttribute("role", "status");
        toastEl.setAttribute("aria-live", "polite");
        toastEl.style.cssText = [
          "position:fixed",
          "right:22px",
          "bottom:22px",
          "z-index:2147483647",
          "max-width:min(360px,80vw)",
          "padding:9px 14px",
          "border-radius:10px",
          "font-size:12px",
          "line-height:1.4",
          "pointer-events:none",
          "box-shadow:0 8px 24px rgba(0,0,0,0.22)",
          "backdrop-filter:blur(12px)",
          "transition:opacity 0.16s ease",
          "opacity:0"
        ].join(";");
        document.body.appendChild(toastEl);
      }
      toastEl.style.background = "var(--cds-surface-popover, rgba(24,24,28,0.92))";
      toastEl.style.color = "var(--cds-text-primary, #f4f4f6)";
      toastEl.style.border = isError
        ? "1px solid rgba(229, 72, 77, 0.7)"
        : "1px solid var(--cds-border, rgba(160,160,175,0.28))";
      toastEl.textContent = String(text || "");
      void toastEl.offsetWidth;
      toastEl.style.opacity = "1";
      toastTimer = setTimeout(function () {
        if (toastEl) toastEl.style.opacity = "0";
      }, 2400);
    } catch (e) {}
  }

  function isRecordingShortcut() {
    try {
      var ae = document.activeElement;
      return !!(ae && typeof ae.closest === "function" && ae.closest(RECORDING_INPUT_SEL));
    } catch (e) {
      return false;
    }
  }

  // Keep main's before-input-event / globalShortcut suppression in sync
  // whenever ANY shortcut recorder input in the view (both ours and
  // upstream's Desktop app ones) takes or drops focus. Always emit true on
  // focusin so redraws that detach the prior focused pill never leave main out
  // of sync.
  var lastRecordingNotified = false;
  function notifyRecording(active) {
    var next = active === true;
    lastRecordingNotified = next;
    try {
      if (typeof api.customShortcutsRecording === "function") {
        api.customShortcutsRecording(next);
      }
    } catch (e) {}
  }
  try {
    document.addEventListener("focusin", function () {
      if (isRecordingShortcut()) notifyRecording(true);
      else if (lastRecordingNotified) notifyRecording(false);
    }, true);
    document.addEventListener("focusout", function () {
      setTimeout(function () {
        if (!isRecordingShortcut() && lastRecordingNotified) notifyRecording(false);
      }, 0);
    }, true);
    window.addEventListener("blur", function () {
      if (lastRecordingNotified) notifyRecording(false);
    });
  } catch (e) {}

  function fiberOf(node) {
    if (!node || typeof node !== "object") return null;
    try {
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) {
          return node[keys[i]];
        }
      }
    } catch (e) {}
    return null;
  }

  function findFiberAncestorProps(node, predicate) {
    var f = fiberOf(node);
    for (var i = 0; f && i < MAX_FIBER_HOPS; i++, f = f.return) {
      var p = f.memoizedProps;
      if (p && typeof p === "object" && predicate(p)) return p;
    }
    return null;
  }

  // Ownership keys a (possibly portaled) control carries on its fiber chain.
  // The turn renderer passes turn.key (= the assistant-message's
  // data-turn-key). The Code tab Read Aloud wrapper passes messageUuid, which
  // is the turn's entry id (annotations entryId, 6.28899.6); it equalled the
  // turn key in the live sample, but ownership accepts either.
  function fiberTurnKeyOf(node) {
    var p = findFiberAncestorProps(node, function (q) {
      return !!q.turn && typeof q.turn === "object" && typeof q.turn.key === "string";
    });
    return p ? p.turn.key : null;
  }

  function fiberMessageUuidOf(node) {
    var p = findFiberAncestorProps(node, function (q) { return typeof q.messageUuid === "string"; });
    return p ? p.messageUuid : null;
  }

  // Tail outlets that hold msgEl's own actions. Ownership is positive: when
  // the outlet's fiber chains yield a turn.key and/or messageUuid, msgEl's
  // data-turn-key must equal one of them (a missing data-turn-key refuses).
  // Only when no fiber data exists at all does upstream's placement rule
  // apply: just the newest turn is portaled there, so msgEl must be the last
  // assistant-message of its transcript.
  function ownedTailOutlets(msgEl) {
    var out = [];
    if (!msgEl) return out;
    try {
      var root = msgEl.closest(TRANSCRIPT_ROOT_SEL) || document;
      var tails = root.querySelectorAll(TAIL_ACTIONS_SEL);
      if (!tails.length) return out;
      var all = root.querySelectorAll(ASSISTANT_MSG_SEL);
      var isNewest = all.length > 0 && all[all.length - 1] === msgEl;
      var key = msgEl.getAttribute("data-turn-key") || "";
      for (var i = 0; i < tails.length; i++) {
        var probes = tails[i].querySelectorAll("button, [data-deferred]");
        if (!probes.length) continue;
        var turnKey = null, entryId = null;
        for (var j = 0; j < probes.length && (turnKey === null || entryId === null); j++) {
          if (turnKey === null) turnKey = fiberTurnKeyOf(probes[j]);
          if (entryId === null) entryId = fiberMessageUuidOf(probes[j]);
        }
        if (turnKey !== null || entryId !== null) {
          if (key && (key === turnKey || key === entryId)) out.push(tails[i]);
          continue;
        }
        if (isNewest) out.push(tails[i]);
      }
    } catch (e) {}
    return out;
  }

  // Streaming is per turn, not per row: with item granularity upstream renders
  // one assistant-message per item, all with the turn's data-turn-key, but only
  // the first/only row carries data-is-streaming (c2a04b80d, 6.28899.6).
  function isTurnStreaming(msgEl) {
    if (msgEl.getAttribute("data-is-streaming") === "true") return true;
    var key = msgEl.getAttribute("data-turn-key") || "";
    if (!key) return false;
    try {
      var root = msgEl.closest(TRANSCRIPT_ROOT_SEL) || document;
      var rows = root.querySelectorAll(ASSISTANT_MSG_SEL + '[data-is-streaming="true"]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute("data-turn-key") === key) return true;
      }
    } catch (e) {}
    return false;
  }

  // Chat buttons carry data-state. The Code tab button does not: read the
  // SpeakAction's "playing" prop from whichever fiber copy (current or
  // alternate; a DOM node can point at a stale one) renders the label the
  // DOM shows now, so the answer is locale-independent.
  function readAloudStateOf(btn) {
    var st = btn.getAttribute("data-state");
    if (st) return st;
    var al = (btn.getAttribute("aria-label") || "").trim();
    var f = fiberOf(btn);
    for (var i = 0; f && i < MAX_FIBER_HOPS; i++, f = f.return) {
      var cands = [f.memoizedProps, f.alternate ? f.alternate.memoizedProps : null];
      for (var j = 0; j < cands.length; j++) {
        var p = cands[j];
        if (p && typeof p === "object" && typeof p.playing === "boolean" &&
            typeof p.label === "string" && p.label.trim() === al) {
          return p.playing ? "playing" : "idle";
        }
      }
    }
    return /^pause$/i.test(al) ? "playing" : "idle";
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      var cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return true;
    }
  }

  function scopeForMessage(msgEl) {
    if (!msgEl) return null;
    try {
      var replyScope = msgEl.closest("[data-reply-scope]");
      if (replyScope) {
        if (replyScope.parentElement && replyScope.parentElement.querySelectorAll(ASSISTANT_MSG_SEL).length <= 1) {
          return replyScope.parentElement;
        }
        if (replyScope.querySelectorAll(ASSISTANT_MSG_SEL).length <= 1) {
          return replyScope;
        }
      }
      if (msgEl.parentElement && msgEl.parentElement.querySelectorAll(ASSISTANT_MSG_SEL).length <= 1) {
        return msgEl.parentElement;
      }
    } catch (e) {}
    return msgEl;
  }

  function findReadAloudButtonInMessage(msgEl) {
    if (!msgEl) return null;
    var roots = [msgEl];
    var scope = scopeForMessage(msgEl);
    if (scope && scope !== msgEl) roots.push(scope);
    roots = roots.concat(ownedTailOutlets(msgEl));

    for (var i = 0; i < roots.length; i++) {
      var btn = roots[i].querySelector(READ_ALOUD_SEL);
      if (btn && !btn.disabled) return btn;
    }

    // Fallback when data-testid changed: locate SpeakAction via fiber props or aria-label.
    var fallbackRe = /^(Read aloud|Pause|Resume|Stop)$/i;
    for (var j = 0; j < roots.length; j++) {
      var box = roots[j].querySelector(ACTIONS_BOX_SEL) || roots[j];
      var btns = box.querySelectorAll("button");
      for (var k = 0; k < btns.length; k++) {
        var b = btns[k];
        if (b.disabled) continue;
        var props = findFiberAncestorProps(b, function (p) {
          return typeof p.onReadAloud === "function" ||
            (typeof p.messageUuid === "string" && typeof p.getText === "function");
        });
        if (props) {
          warnOnce("read-aloud-testid-fallback", "matched Read Aloud button via fiber props");
          return b;
        }
        var al = (b.getAttribute("aria-label") || "").trim();
        if (fallbackRe.test(al)) {
          warnOnce("read-aloud-label-fallback", "matched Read Aloud button via aria-label");
          return b;
        }
      }
    }
    return null;
  }

  function findDeferredActionsInMessage(msgEl) {
    if (!msgEl) return null;
    var el = msgEl.querySelector(DEFERRED_ACTIONS_SEL);
    if (el) return el;
    var scope = scopeForMessage(msgEl);
    el = scope ? scope.querySelector(DEFERRED_ACTIONS_SEL) : null;
    if (el) return el;
    var tails = ownedTailOutlets(msgEl);
    for (var i = 0; i < tails.length; i++) {
      el = tails[i].querySelector(DEFERRED_ACTIONS_SEL);
      if (el) return el;
    }
    return null;
  }

  function hydrateDeferredActions(deferredEl) {
    if (!deferredEl) return;
    var prevFocus = document.activeElement;
    try {
      deferredEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
      if (typeof PointerEvent === "function") {
        deferredEl.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, cancelable: true }));
        deferredEl.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, cancelable: false }));
        // Code tab tail outlet: upstream marks it reached on pointerenter of the tail turn.
        var tailTurn = deferredEl.closest(TAIL_TURN_SEL);
        if (tailTurn) tailTurn.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, cancelable: false }));
      }
    } catch (e) {}
    try {
      var srBtn = deferredEl.querySelector("button.sr-only, button");
      if (srBtn && !srBtn.disabled) srBtn.click();
    } catch (e2) {}
    try {
      if (prevFocus && prevFocus !== document.activeElement && typeof prevFocus.focus === "function") {
        prevFocus.focus({ preventScroll: true });
      }
    } catch (e3) {}
  }

  function waitForReadAloudButton(msgEl, framesLeft) {
    return new Promise(function (resolve) {
      function step(left) {
        var btn = findReadAloudButtonInMessage(msgEl);
        if (btn) { resolve(btn); return; }
        if (left <= 0) { resolve(null); return; }
        var raf = typeof requestAnimationFrame === "function"
          ? requestAnimationFrame
          : function (fn) { return setTimeout(fn, 16); };
        raf(function () { step(left - 1); });
      }
      step(framesLeft);
    });
  }

  function triggerReadAloud() {
    // 1. If any Read Aloud button is currently playing or loading, toggle it immediately.
    var allBtns = document.querySelectorAll(READ_ALOUD_SEL);
    for (var i = 0; i < allBtns.length; i++) {
      var st = readAloudStateOf(allBtns[i]);
      if ((st === "playing" || st === "loading") && !allBtns[i].disabled) {
        allBtns[i].click();
        return Promise.resolve({ ok: true, action: "readAloud", detail: "toggled-active:" + st });
      }
    }

    // 2. Locate the newest completed assistant reply.
    var msgs = document.querySelectorAll(ASSISTANT_MSG_SEL);
    if (!msgs.length) {
      showNotice("No Claude reply to read aloud in this view");
      return Promise.resolve({ ok: false, action: "readAloud", reason: "no-message" });
    }

    var target = null;
    var sawStreaming = false;
    for (var m = msgs.length - 1; m >= 0; m--) {
      if (isTurnStreaming(msgs[m])) {
        sawStreaming = true;
        // If a streaming reply already exposes its button, allow reading it; otherwise prefer latest completed.
        if (findReadAloudButtonInMessage(msgs[m])) {
          target = msgs[m];
          break;
        }
        continue;
      }
      target = msgs[m];
      break;
    }

    if (!target) {
      showNotice(sawStreaming ? "Wait for Claude to finish responding" : "No completed Claude reply to read aloud");
      return Promise.resolve({ ok: false, action: "readAloud", reason: sawStreaming ? "streaming" : "no-message" });
    }

    var direct = findReadAloudButtonInMessage(target);
    if (direct) {
      direct.click();
      return Promise.resolve({ ok: true, action: "readAloud", detail: "clicked:" + readAloudStateOf(direct) });
    }

    var deferred = findDeferredActionsInMessage(target);
    if (deferred) {
      hydrateDeferredActions(deferred);
      return waitForReadAloudButton(target, DEFERRED_WAIT_FRAMES).then(function (btn) {
        if (btn) {
          btn.click();
          return { ok: true, action: "readAloud", detail: "clicked-after-hydrate" };
        }
        warnOnce("read-aloud-missing-after-hydrate", "deferred message actions did not reveal Read Aloud button");
        showNotice("Read Aloud is not available on this message");
        return { ok: false, action: "readAloud", reason: "missing-button" };
      });
    }

    warnOnce("read-aloud-missing", "assistant-message has neither Read Aloud button nor deferred actions");
    showNotice("Read Aloud is not available on this message");
    return Promise.resolve({ ok: false, action: "readAloud", reason: "missing-button" });
  }

  function closeSettingsIfOpen() {
    try {
      var dialogs = document.querySelectorAll(SETTINGS_DIALOG_SEL);
      for (var i = 0; i < dialogs.length; i++) {
        var dlg = dialogs[i];
        var isSettings = !!(dlg.querySelector('nav[aria-label="Settings"], .cdbx-item, [data-testid="general-settings"]'));
        if (!isSettings) continue;
        var closeBtn = dlg.querySelector('button[aria-label="Close"], button[aria-label="close"]');
        if (closeBtn && !closeBtn.disabled) {
          closeBtn.click();
          return true;
        }
        // Fallback: dispatch Escape on dialog.
        dlg.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        return true;
      }
    } catch (e) {}
    return false;
  }

  function isVoiceUnsupportedRoute() {
    var p = "";
    try { p = String(location.pathname || ""); } catch (e) {}
    return /^\/(code|epitaxy|cowork)(\/|$)/.test(p);
  }

  function findActiveVoiceBar() {
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!isVisible(b)) continue;
      var props = findFiberAncestorProps(b, function (p) {
        return (p.state === "active" || p.state === "connecting") &&
          (typeof p.onEnd === "function" || typeof p.onCancel === "function");
      });
      if (props) return { btn: b, props: props };
    }
    // DOM fallback if fiber props changed: look for Stop/Cancel voice pill next to held-voice-mode-button or Mic mute button.
    var stopLabels = ["Stop", "Cancel", "End voice mode"];
    for (var j = 0; j < btns.length; j++) {
      var bj = btns[j];
      if (bj.disabled || !isVisible(bj)) continue;
      var txt = (bj.textContent || "").trim();
      var aria = (bj.getAttribute("aria-label") || "").trim();
      if (stopLabels.indexOf(txt) >= 0 || aria === "End voice mode") {
        // Confirm it belongs to a voice bar (sibling or ancestor has Turn off/on microphone or audio-visualizer bars).
        var parent = bj.parentElement && bj.parentElement.parentElement;
        if (parent && parent.querySelector('button[aria-label="Turn off microphone"], button[aria-label="Turn on microphone"], [data-testid="held-voice-mode-button"], [data-testid="held-voice-control"]')) {
          warnOnce("voice-active-dom-fallback", "matched active voice bar via DOM fallback");
          return { btn: bj, props: null };
        }
      }
    }
    return null;
  }

  function findReactElementInTree(node, predicate, depth) {
    if (!node || depth > 12) return null;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var hit = findReactElementInTree(node[i], predicate, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof node !== "object") return null;
    var p = node.props;
    if (p && typeof p === "object") {
      if (predicate(node)) return node;
      if (p.children) return findReactElementInTree(p.children, predicate, depth + 1);
    }
    return null;
  }

  function findIdleVoiceStarter() {
    // 1. Direct qR idle pill (fiber props state === "idle" && onStart).
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var bi = btns[i];
      if (bi.disabled || !isVisible(bi)) continue;
      var qrProps = findFiberAncestorProps(bi, function (p) {
        return p.state === "idle" && typeof p.onStart === "function";
      });
      if (qrProps) {
        return { kind: "qr", btn: bi, props: qrProps };
      }
    }

    // 2. Direct "Use voice mode" button (standalone OR or split button pinned to voice).
    var direct = document.querySelectorAll(VOICE_BTN_SEL);
    for (var j = 0; j < direct.length; j++) {
      if (!direct[j].disabled && isVisible(direct[j])) {
        return { kind: "direct", btn: direct[j] };
      }
    }

    // 3. Split / compact Voice input button (xR) when Dictate is currently pinned.
    for (var k = 0; k < btns.length; k++) {
      var bk = btns[k];
      if (bk.disabled || !isVisible(bk)) continue;
      var xrProps = findFiberAncestorProps(bk, function (p) {
        return "items" in p && ("onPrimaryClick" in p || p.menuLabel === "Voice input" || p.menuLabel === "Microphone");
      });
      if (xrProps && xrProps.items) {
        // Compact menu carries a direct "Phone" Voice mode item whose onClick is handleStartVoice.
        var phoneItem = findReactElementInTree(xrProps.items, function (el) {
          return el.props && el.props.icon === "Phone" && typeof el.props.onClick === "function";
        }, 0);
        if (phoneItem) {
          return { kind: "item-click", onClick: phoneItem.props.onClick };
        }
        // Split menu carries a "Voice" radio item that pins voice as the primary button.
        var voiceRadio = findReactElementInTree(xrProps.items, function (el) {
          return el.props && el.props.icon === "Voice" && typeof el.props.onClick === "function";
        }, 0);
        if (voiceRadio) {
          return { kind: "pin-then-start", pinVoice: voiceRadio.props.onClick, btn: bk };
        }
      }
    }
    return null;
  }

  function invokeStarterOnce(starter) {
    if (!starter) return Promise.resolve(false);
    if (starter.kind === "qr" && starter.props && typeof starter.props.onStart === "function") {
      starter.props.onStart();
      return Promise.resolve(true);
    }
    if (starter.kind === "item-click" && typeof starter.onClick === "function") {
      starter.onClick();
      return Promise.resolve(true);
    }
    if (starter.kind === "pin-then-start") {
      starter.pinVoice();
      return new Promise(function (resolve) {
        setTimeout(function () {
          var next = findIdleVoiceStarter();
          if (next && next.kind !== "pin-then-start") {
            invokeStarterOnce(next).then(resolve);
          } else {
            resolve(false);
          }
        }, 50);
      });
    }
    if (starter.btn && !starter.btn.disabled) {
      starter.btn.click();
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  function startVoiceInComposer(bypassMistap) {
    var starter = findIdleVoiceStarter();
    if (!starter) return Promise.resolve(false);
    var needsSettle = bypassMistap || starter.kind === "pin-then-start";
    return invokeStarterOnce(starter).then(function (didInvoke) {
      if (!didInvoke) return false;
      if (!needsSettle) return true;
      // ER() enforces a 350 ms mistap suppression window after composer mount
      // or when pinning Voice flips startsVoice -> true.
      // Check shortly after click; if voice mode stayed idle, retry once after the window.
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (findActiveVoiceBar()) { resolve(true); return; }
          setTimeout(function () {
            if (findActiveVoiceBar()) { resolve(true); return; }
            var retryStarter = findIdleVoiceStarter();
            if (!retryStarter) { resolve(false); return; }
            invokeStarterOnce(retryStarter).then(function (ok2) { resolve(ok2); });
          }, VOICE_MISTAP_SETTLE_MS);
        }, 60);
      });
    });
  }

  function stopActiveVoiceBar(active) {
    if (!active) return false;
    try {
      if (active.props) {
        if (active.props.state === "active" && typeof active.props.onEnd === "function") {
          active.props.onEnd();
          return true;
        }
        if (active.props.state === "connecting" && typeof active.props.onCancel === "function") {
          active.props.onCancel();
          return true;
        }
      }
      if (active.btn && !active.btn.disabled) {
        active.btn.click();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function triggerVoiceMode() {
    closeSettingsIfOpen();
    var active = findActiveVoiceBar();
    if (active) {
      if (stopActiveVoiceBar(active)) {
        return Promise.resolve({ ok: true, action: "voiceMode", detail: "stopped" });
      }
      warnOnce("voice-stop-failed", "failed to trigger active Voice mode stop control");
      return Promise.resolve({ ok: false, action: "voiceMode", reason: "stop-failed" });
    }

    if (isVoiceUnsupportedRoute()) {
      showNotice("Voice mode is only available in Chat");
      return Promise.resolve({ ok: false, action: "voiceMode", reason: "unsupported-route" });
    }

    return startVoiceInComposer(false).then(function (started) {
      if (started) return { ok: true, action: "voiceMode", detail: "started" };
      warnOnce("voice-button-missing", "no Voice mode trigger found in current view");
      showNotice("Voice mode is not available in this view");
      return { ok: false, action: "voiceMode", reason: "missing-button" };
    });
  }

  function clickNewChatFallback() {
    var selectors = [
      'a[href="/new"]',
      'a[href="/new/"]',
      '[data-testid="new-chat-trigger"]',
      'button[aria-label="New chat"]',
      'a[aria-label="New chat"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && !el.disabled && isVisible(el)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function isNewChatReady() {
    var path = "";
    try { path = String(location.pathname || ""); } catch (e) {}
    if (path !== "/new" && path !== "/") return false;
    if (findActiveVoiceBar()) return false;
    return !!findIdleVoiceStarter();
  }

  function waitForNewChatAndStart(opts) {
    var startedAt = Date.now();
    var navigatedByMain = !!(opts && opts.navigatedByMain);
    var stoppedActive = !!(opts && opts.stoppedActive);

    // If we are already in a clean empty /new composer with no conversation turns
    // and did not just trigger an active voice bar teardown, start immediately.
    if (!stoppedActive && isNewChatReady() && !document.querySelector(ASSISTANT_MSG_SEL)) {
      return startVoiceInComposer(true).then(function (ok) {
        if (ok) return { ok: true, action: "newVoiceChat", detail: "started-in-new" };
        showNotice("Voice mode is not available in this view");
        return { ok: false, action: "newVoiceChat", reason: "missing-button" };
      });
    }

    if (!navigatedByMain) {
      if (!clickNewChatFallback()) {
        warnOnce("new-chat-nav-missing", "no navigation dispatcher or New chat link available");
      }
    }

    return new Promise(function (resolve) {
      function poll() {
        if (isNewChatReady()) {
          // Wait briefly past ER's 350 ms mistap window after /new composer mounts.
          setTimeout(function () {
            startVoiceInComposer(true).then(function (ok) {
              if (ok) {
                resolve({ ok: true, action: "newVoiceChat", detail: "started" });
              } else {
                warnOnce("new-voice-button-missing", "Voice mode trigger missing on /new");
                showNotice("Voice mode is not available in this view");
                resolve({ ok: false, action: "newVoiceChat", reason: "missing-button" });
              }
            });
          }, VOICE_MISTAP_SETTLE_MS);
          return;
        }
        if (Date.now() - startedAt >= NEW_CHAT_TIMEOUT_MS) {
          warnOnce("new-chat-timeout", "timed out waiting for /new Voice mode composer");
          showNotice("Timed out opening a new voice chat", true);
          resolve({ ok: false, action: "newVoiceChat", reason: "timeout" });
          return;
        }
        setTimeout(poll, NEW_CHAT_POLL_MS);
      }
      setTimeout(poll, NEW_CHAT_POLL_MS);
    });
  }

  function triggerNewVoiceChat(opts) {
    closeSettingsIfOpen();
    var active = findActiveVoiceBar();
    var stoppedActive = stopActiveVoiceBar(active);
    var nextOpts = Object.assign({}, opts || {}, { stoppedActive: stoppedActive });
    return waitForNewChatAndStart(nextOpts);
  }

  function isSettingsDialogEl(el) {
    if (!el || typeof el.closest !== "function") return false;
    try {
      var dlg = el.closest(SETTINGS_DIALOG_SEL);
      if (!dlg) return false;
      return !!(dlg.querySelector('nav[aria-label="Settings"], .cdbx-item, [data-testid="general-settings"]'));
    } catch (e) {
      return false;
    }
  }

  function isButtonBusy(btn) {
    if (!btn) return false;
    return btn.getAttribute("aria-busy") === "true" || btn.getAttribute("data-busy") === "true";
  }

  function isButtonDisabled(btn) {
    if (!btn) return true;
    return !!btn.disabled || btn.getAttribute("aria-disabled") === "true";
  }

  function buttonLabelWithoutKbd(btn) {
    if (!btn) return "";
    try {
      if (!btn.querySelector("kbd")) return (btn.textContent || "").trim();
      var clone = btn.cloneNode(true);
      var kbds = clone.querySelectorAll("kbd");
      for (var i = 0; i < kbds.length; i++) kbds[i].remove();
      return (clone.textContent || "").trim();
    } catch (e) {
      return (btn.textContent || "").trim();
    }
  }

  function findSendNowCandidate() {
    // 1. Primary upstream selector: cf7fce8a8 renders data-testid="awaiting-turn-send-now"
    //    on Code, Cowork, and Chat queued-message "Send now" / "Send N now" buttons.
    var direct = document.querySelectorAll(SEND_NOW_SEL);
    var sawBusy = false;
    var sawDisabled = false;
    for (var i = direct.length - 1; i >= 0; i--) {
      var b = direct[i];
      if (!isVisible(b) || isSettingsDialogEl(b)) continue;
      if (isButtonBusy(b)) { sawBusy = true; continue; }
      if (isButtonDisabled(b)) { sawDisabled = true; continue; }
      return { btn: b, source: "testid" };
    }
    if (sawBusy) return { btn: null, reason: "busy" };
    if (sawDisabled) return { btn: null, reason: "disabled" };

    // 2. Fallback: React fiber props (onSendNow) paired with button-level marker
    //    or "Send [N] now" label (never clicks sibling row buttons like Remove),
    //    or plain visible "Send [N] now" button (also covers held-message banners).
    var labelRe = /^Send(?:\s+\d+)?\s+now$/i;
    var btns = document.querySelectorAll("button");
    var fiberHit = null;
    var labelHit = null;
    for (var j = btns.length - 1; j >= 0; j--) {
      var bj = btns[j];
      if (!isVisible(bj) || isSettingsDialogEl(bj)) continue;
      var lbl = buttonLabelWithoutKbd(bj);
      var hasSendMarker = bj.hasAttribute("data-press-renders-now") ||
        bj.hasAttribute("data-transcript-continues-turn");
      var matchesLabel = labelRe.test(lbl);
      if (!hasSendMarker && !matchesLabel) continue;
      var props = findFiberAncestorProps(bj, function (p) {
        return typeof p.onSendNow === "function";
      });
      if (props) {
        if (isButtonBusy(bj)) { sawBusy = true; continue; }
        if (isButtonDisabled(bj)) { sawDisabled = true; continue; }
        if (!fiberHit) fiberHit = bj;
        continue;
      }
      if (matchesLabel) {
        if (isButtonBusy(bj)) { sawBusy = true; continue; }
        if (isButtonDisabled(bj)) { sawDisabled = true; continue; }
        if (!labelHit) labelHit = bj;
      }
    }
    if (fiberHit) {
      warnOnce("send-now-fiber-fallback", "matched Send now button via fiber props");
      return { btn: fiberHit, source: "fiber" };
    }
    if (labelHit) {
      warnOnce("send-now-label-fallback", "matched Send now button via label fallback");
      return { btn: labelHit, source: "label" };
    }
    if (sawBusy) return { btn: null, reason: "busy" };
    if (sawDisabled) return { btn: null, reason: "disabled" };
    return { btn: null, reason: "no-queued-message" };
  }

  function triggerSendNow() {
    var hit = findSendNowCandidate();
    if (hit.btn) {
      hit.btn.click();
      return Promise.resolve({ ok: true, action: "sendNow", detail: "clicked:" + hit.source });
    }
    if (hit.reason === "busy") {
      showNotice("Queued message is already being sent");
      return Promise.resolve({ ok: false, action: "sendNow", reason: "busy" });
    }
    if (hit.reason === "disabled") {
      showNotice("Send now is currently unavailable");
      return Promise.resolve({ ok: false, action: "sendNow", reason: "disabled" });
    }
    showNotice("No queued message ready to send now");
    return Promise.resolve({ ok: false, action: "sendNow", reason: "no-queued-message" });
  }

  function trigger(actionId, opts) {
    if (actionId === "readAloud") return triggerReadAloud();
    if (actionId === "voiceMode") return triggerVoiceMode();
    if (actionId === "newVoiceChat") return triggerNewVoiceChat(opts);
    if (actionId === "sendNow") return triggerSendNow();
    return Promise.resolve({ ok: false, action: String(actionId || ""), reason: "unknown-action" });
  }

  window.__cdbCustomShortcuts = {
    _installed: true,
    trigger: trigger,
    isRecordingShortcut: isRecordingShortcut,
    state: function () {
      var msgs = document.querySelectorAll(ASSISTANT_MSG_SEL);
      var readBtns = document.querySelectorAll(READ_ALOUD_SEL);
      var sendNowBtns = document.querySelectorAll(SEND_NOW_SEL);
      var playing = 0;
      for (var i = 0; i < readBtns.length; i++) {
        if (readAloudStateOf(readBtns[i]) === "playing") playing++;
      }
      return {
        path: String((location && location.pathname) || ""),
        recording: isRecordingShortcut(),
        assistantMessages: msgs.length,
        readAloudButtons: readBtns.length,
        readAloudPlaying: playing,
        voiceActive: !!findActiveVoiceBar(),
        voiceIdleAvailable: !!findIdleVoiceStarter(),
        sendNowButtons: sendNowBtns.length,
        sendNowAvailable: !!findSendNowCandidate().btn
      };
    }
  };

  return "custom-shortcuts: installed";
})();
