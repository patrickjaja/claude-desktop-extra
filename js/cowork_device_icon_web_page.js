/*
 * cowork_device_icon_web_page.js - the Cowork device icon in the claude.ai
 * chat header (1P mode, Linux). Embedded in js/cowork_device_icon_web_main.js
 * by patches/linux/fix_cowork_device_icon_web.nim and run in the page's main
 * world on every dom-ready of the main view.
 *
 * Upstream shows a device icon in a chat's title row only when the chat is
 * linked to a computer (cowork-computer-link-indicator) or runs on this one
 * (cowork-local-session-indicator). A chat that is not linked shows nothing,
 * and on a desktop without a device key (no /dev/tpmrm0 access) that is every
 * chat, with nothing saying why. This file:
 *
 *   details row  upstream indicator present: its popover gets one more row,
 *                "Linux details" (plus the local VM readiness line in the
 *                local popover), which opens Settings -> Extra -> Cowork (Linux).
 *                Upstream's icon and rows are never touched.
 *   our icon     no upstream indicator and no upstream placeholder slot in a
 *                /chat/ or /cowork/ title row: a laptop button in the row's
 *                trailing slot. X badge when this desktop has no device key
 *                (deviceLinkStore idSource exactly "keyless" or "none"), amber
 *                dot when it has one but this chat is not linked, a plain
 *                laptop when the key state is not known (store missing, no or
 *                an unknown idSource) or for a local session whose upstream
 *                icon is missing. Its popover says so and links to the page.
 *
 * Our icon is removed the moment upstream renders its indicator or slot in
 * the same row, so there is never a second icon.
 *
 * Anchors (remote claude.ai code, re-validate with
 * baseline/COWORK_HEADER_ICON_ANCHORS.md):
 *   - routes /chat/<id> and /cowork/<id>; local sessions are local_<uuid>
 *   - title row [data-testid="session-title-split"], trailing slot span.ms-1
 *   - title fiber props {sessionTitle, sessionId, ...} (session id)
 *   - [data-testid="cowork-computer-link-indicator"|"cowork-local-session-indicator"],
 *     placeholder [data-testid="cowork-computer-link-indicator-slot"]
 *   - popover [data-cds="PreviewCard"], button[data-testid="cowork-computer-link-manage"]
 *   - globalThis["claude.web"].WindowState.deviceLinkStore {getStateSync, onStateChange}
 * A missing anchor logs one "[cdb-cowork-icon] <key>: ..." console.warn (lands
 * in claude.ai-web.log) and one cdbExtra.diag line (claude-patches.log). Page
 * text never goes into either.
 */
(function () {
  "use strict";
  var existing = window.__cdbCoworkIcon;
  if (window.__cdbCoworkIconInstalled && existing && typeof existing.refresh === "function") {
    existing.refresh();
    return;
  }
  // 1P claude.ai only; the main view is the one with our bridge (popups and
  // helper views have no cdbExtra and get nothing).
  if (location.protocol !== "https:") return;
  var api = window.cdbExtra;
  if (!api || typeof api !== "object") return;
  window.__cdbCoworkIconInstalled = true;

  var ROUTE = /^\/(chat|cowork)\/([^\/?#]+)/;
  var SPLIT = '[data-testid="session-title-split"]';
  var LINK_IND = '[data-testid="cowork-computer-link-indicator"]';
  var LOCAL_IND = '[data-testid="cowork-local-session-indicator"]';
  var SLOT = '[data-testid^="cowork-"][data-testid$="-slot"]';
  var CARD = '[data-cds="PreviewCard"]';
  var MANAGE = 'button[data-testid="cowork-computer-link-manage"]';
  var ATTR = "data-cdb-cowork-icon";
  var OURS = ".cdb-cowork-icon,.cdb-cowork-icon-slot,.cdb-cowork-icon-pop,.cdb-cowork-icon-row,.cdb-cowork-icon-mode";
  var SVGNS = "http://www.w3.org/2000/svg";
  var MAX_HOPS = 40;
  var DEBOUNCE_MS = 50;
  var HEADER_MISSES = 30; // session-route scans without a title row before "no-header"

  var TEXT = {
    keyless: {
      label: "This computer: no device key, no Computer Use for cloud tasks",
      title: "No device key",
      // Measured: a keyless desktop still links chats and runs their files and
      // commands; what it loses is Computer Use (screen and input tools).
      text: "Cloud tasks can't use Computer Use (screen and input) on this computer. Files and commands still work.",
      action: "Set up", section: "cloud"
    },
    "keyed-unbound": {
      label: "This computer: not connected to this chat",
      title: "Not connected to this chat",
      text: null, // device status line, see popText()
      action: "Linux details", section: "cloud"
    },
    neutral: {
      label: "This computer: Cowork on Linux",
      title: "This computer",
      text: null, // no claim: the device key state is not known
      action: "Linux details", section: "cloud"
    },
    local: {
      label: "This computer: runs in the local VM",
      title: "Runs on this computer (local VM)",
      text: null, // readiness line from cuStatusIcon()
      action: "Linux details", section: "local"
    }
  };

  var warned = {};
  function noop() {}
  function warn(key, what) {
    if (warned[key]) return;
    warned[key] = true;
    var line = "[cdb-cowork-icon] " + key + ": " + what;
    try { console.warn(line); } catch (e) {}
    try {
      if (typeof api.diag === "function") Promise.resolve(api.diag(line)).then(null, noop);
    } catch (e) {}
  }

  // ---- pure state ------------------------------------------------------------
  // input = {upstream:"indicator"|"slot"|"none", cloud:boolean,
  //          device:{connected:boolean, idSource:string}|null}
  function iconState(input) {
    if (!input || typeof input !== "object") return "none";
    if (input.upstream === "indicator") return "details-row";
    if (input.upstream !== "none") return "none"; // "slot": binding not known yet
    if (!input.cloud) return "local";
    var d = input.device;
    var src = d && typeof d === "object" ? d.idSource : undefined;
    // Only an explicit answer earns a warning: no store, no idSource or one we
    // do not know (first start, device link off for the org, a renamed
    // store) is neutral.
    if (src === "keyless" || src === "none") return "keyless";
    if (src === "keyed") return "keyed-unbound";
    return "neutral";
  }

  // ---- device link store -----------------------------------------------------
  var devState;            // last state seen (undefined = never read)
  var devSubscribed = false;
  var devReadFor = null;   // session the last sync read was for (no subscription)
  function deviceStore() {
    try {
      var s = window["claude.web"] && window["claude.web"].WindowState && window["claude.web"].WindowState.deviceLinkStore;
      return s && typeof s.getStateSync === "function" ? s : null;
    } catch (e) { return null; }
  }
  function deviceState(sessionKey) {
    var s = deviceStore();
    if (!s) {
      warn("no-device-store", "globalThis[\"claude.web\"].WindowState.deviceLinkStore.getStateSync is missing; showing the neutral icon");
      return null;
    }
    if (!devSubscribed && typeof s.onStateChange === "function") {
      try {
        s.onStateChange(function (v) { devState = v; schedule(); });
        devSubscribed = true;
      } catch (e) {}
    }
    // Subscribed: one sync read, then the updates. Not subscribed: one sync
    // read per session shown (sendSync is not something to run per mutation).
    if (devState === undefined || (!devSubscribed && devReadFor !== sessionKey)) {
      devReadFor = sessionKey;
      try { devState = s.getStateSync(); } catch (e) {
        devState = null;
        warn("no-device-store", "deviceLinkStore.getStateSync threw; showing the neutral icon");
      }
    }
    return devState && typeof devState === "object" ? devState : null;
  }

  // ---- fiber read (read-only) --------------------------------------------------
  function fiberOf(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactFiber$") === 0) return el[keys[i]];
    }
    return null;
  }
  // The title component's session id; the URL's id when the seat is not found.
  function sessionIdOf(split, urlId) {
    var f = fiberOf(split);
    if (!f) { warn("no-seat", "the session title row has no __reactFiber$ key"); return urlId; }
    for (var i = 0; f && i < MAX_HOPS; i++, f = f.return) {
      var p = f.memoizedProps;
      if (p && typeof p === "object" && "sessionTitle" in p && "sessionId" in p) {
        if (typeof p.sessionId === "string" && p.sessionId.length > 0) return p.sessionId;
        warn("no-session", "the title fiber {sessionTitle, sessionId} has no string sessionId; using the URL");
        return urlId;
      }
    }
    warn("no-seat", "no ancestor fiber of the session title row within " + MAX_HOPS + " hops has props {sessionTitle, sessionId}");
    return urlId;
  }

  function ours(node) {
    return !!(node && node.nodeType === 1 && (node.matches(OURS) || node.closest(OURS)));
  }

  // ---- deep link ---------------------------------------------------------------
  function deepLink(section) {
    closePop(false);
    var open = window.__cdbExtraOpen;
    if (typeof open === "function") {
      var handled = false;
      try { handled = open("cu", section) === true; } catch (e) {
        warn("deeplink-error", "window.__cdbExtraOpen threw; opening upstream settings only");
      }
      if (handled) return;
      // false: the page already told the user; settings still help.
      if (!warned["deeplink-error"]) warn("deeplink-refused", "window.__cdbExtraOpen(\"cu\") returned false; opening upstream settings only");
    } else {
      warn("no-deeplink", "window.__cdbExtraOpen is missing (Extra settings page not installed?); opening upstream settings only");
    }
    if (typeof api.extraOpenSettings === "function") {
      Promise.resolve().then(function () { return api.extraOpenSettings(); }).then(null, noop);
    }
  }

  // ---- readiness line (local) ----------------------------------------------------
  // One line: the mode plus the VM state (running / ready / not available,
  // with main's reason). cuStatusIcon() once per call.
  // The local VM's state from main's cached icon facts (cuStatusIcon, one
  // call per popover): {kind:"checking"|"running"|"ready"|"na"|"unknown", reason}.
  function vmState(r) {
    var line = r && r.ok === true && typeof r.line === "string" ? r.line.slice(0, 200) : "";
    if (!line) return { kind: "unknown", reason: "" };
    if (r.vm && r.vm.running === true) return { kind: "running", reason: "" };
    if (line.indexOf("Local VM ready") === 0) return { kind: "ready", reason: "" };
    return { kind: "na", reason: line.replace(/^Local VM( unavailable)?:\s*/, "") };
  }
  function withVm(target, text) {
    target.textContent = text({ kind: "checking", reason: "" });
    function set(r) { target.textContent = text(vmState(r)); }
    if (typeof api.cuStatusIcon !== "function") { set(null); return; }
    Promise.resolve().then(function () { return api.cuStatusIcon(); }).then(set, function () { set(null); });
  }
  var LOCAL_MODE = "Runs in the local VM on this computer";
  function localText(v) {
    return LOCAL_MODE + " - " + (v.kind === "checking" ? "checking..." : v.kind === "running" ? "running"
      : v.kind === "ready" ? "ready" : v.kind === "na" ? "not available (" + v.reason + ")" : "status unavailable");
  }
  function readiness(target) { withVm(target, localText); }
  // A linked chat's files and commands run in the linked computer's local
  // Cowork VM (measured: [remote-bash] / [vmOneShot] in the VM for a linked
  // cloud chat).
  function linkedText(name) {
    return function (v) {
      if (v.kind === "na") return "Runs in the cloud - " + name + " is linked, but its local Cowork VM is not available (" + v.reason + ")";
      var tail = v.kind === "running" ? " (running)" : v.kind === "ready" ? " (ready)" : v.kind === "checking" ? " (checking...)" : "";
      return "Runs in the cloud - files and commands on " + name + " run in its local Cowork VM" + tail;
    };
  }
  // The computer a linked chat uses: the card's title, else the indicator's
  // aria-label up to the comma ("jajapc, Connected"), else "this computer".
  function computerName(card) {
    var name = "";
    var id = card && card.getAttribute("aria-labelledby");
    var t = id ? document.getElementById(id) : null;
    if (t && card.contains(t)) name = String(t.textContent || "").trim();
    if (!name) {
      var ind = document.querySelector(LINK_IND + "[data-popup-open]") || document.querySelector(LINK_IND);
      name = ind ? String(ind.getAttribute("aria-label") || "").split(",")[0].trim() : "";
    }
    return name ? name.slice(0, 80) : "this computer";
  }
  var MODE_CLS = "px-md py-xs text-footnote text-secondary";
  // The mode line sits in upstream's status block (above its divider), right
  // after the last status line, styled like that line so the inset matches.
  // Returns false when there is no status block to join.
  function placeMode(card, line, kind) {
    var after = null;
    if (kind === "cloud") {
      after = card.querySelector('[data-testid="cowork-computer-link-status-detail"]') ||
        card.querySelector('[data-testid="cowork-computer-link-status"]');
      if (after && after.nextElementSibling && after.nextElementSibling.matches('[data-testid="cowork-computer-link-status-detail"]')) after = after.nextElementSibling;
    } else {
      var title = card.querySelector("span");
      var block = title && title.parentNode;
      if (block && block !== card && card.contains(block)) after = block.lastElementChild;
    }
    if (!after || !after.parentNode) return false;
    var model = kind === "cloud" ? card.querySelector('[data-testid="cowork-computer-link-status-detail"]')
      : (after !== card.querySelector("span") ? after : null);
    var cls = model ? String(model.className || "").trim() : "";
    line.className = "cdb-cowork-icon-mode cdb-cowork-icon-line " + (cls || "text-footnote text-secondary");
    after.parentNode.insertBefore(line, after.nextSibling);
    return true;
  }

  // ---- our icon -----------------------------------------------------------------
  function svg(name, attrs) {
    var n = document.createElementNS(SVGNS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function laptopGlyph() {
    var s = svg("svg", { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", "stroke-width": "1.5",
      "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" });
    s.appendChild(svg("rect", { x: "4", y: "4.5", width: "12", height: "8.5", rx: "1.25" }));
    s.appendChild(svg("path", { d: "M2.5 15.5h15" }));
    return s;
  }
  function badgeGlyph() {
    var s = svg("svg", { viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", "stroke-width": "1.6",
      "stroke-linecap": "round", "aria-hidden": "true", focusable: "false" });
    s.appendChild(svg("path", { d: "M3 3l4 4M7 3l-4 4" }));
    return s;
  }

  var buttons = new Map();   // title row -> our button
  var ownSlots = new Map();  // title row -> our slot span (when upstream has none)
  var popSeq = 0;

  function makeButton() {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "cdb-cowork-icon";
    b.setAttribute("aria-haspopup", "dialog");
    b.setAttribute("aria-expanded", "false");
    b.appendChild(laptopGlyph());
    var badge = document.createElement("span");
    badge.className = "cdb-cowork-icon-badge";
    badge.setAttribute("aria-hidden", "true");
    b.appendChild(badge);
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (pop && pop.owner === b) closePop(false);
      else openPop(b);
    });
    return b;
  }
  function setVariant(b, st) {
    if (b.getAttribute(ATTR) === st) return;
    b.setAttribute(ATTR, st);
    b.setAttribute("aria-label", TEXT[st].label);
    var badge = b.querySelector(".cdb-cowork-icon-badge");
    while (badge.firstChild) badge.removeChild(badge.firstChild);
    if (st === "keyless") badge.appendChild(badgeGlyph());
    if (pop && pop.owner === b) closePop(false);
  }
  // Upstream's trailing slot when it has one; otherwise our own, last in the row.
  function place(split, b) {
    var slot = null;
    for (var c = split.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName === "SPAN" && c.classList.contains("ms-1") && !ours(c)) { slot = c; break; }
    }
    var own = ownSlots.get(split);
    if (slot) {
      if (b.parentNode !== slot || slot.lastChild !== b) slot.appendChild(b);
      if (own) { own.remove(); ownSlots.delete(split); }
      return;
    }
    if (!own) {
      own = document.createElement("span");
      own.className = "ms-1 cdb-cowork-icon-slot";
      ownSlots.set(split, own);
    }
    if (b.parentNode !== own) own.appendChild(b);
    if (split.lastChild !== own) split.appendChild(own);
  }
  function unplace(split) {
    var b = buttons.get(split);
    if (b) {
      if (pop && pop.owner === b) closePop(false);
      b.remove();
      buttons.delete(split);
    }
    var own = ownSlots.get(split);
    if (own) { own.remove(); ownSlots.delete(split); }
  }

  // ---- our popover ------------------------------------------------------------------
  var pop = null; // {el, owner, onKey, onDown}
  function popText(st, owner) {
    if (st === "keyed-unbound") {
      var d = deviceState(owner.getAttribute("data-cdb-session") || "");
      return d && d.connected === true
        ? "This computer is connected with a device key, but this chat is not linked to it."
        : "This computer has a device key but is not connected right now.";
    }
    return TEXT[st].text;
  }
  function openPop(b) {
    closePop(false);
    var st = b.getAttribute(ATTR);
    var t = TEXT[st];
    if (!t) return;
    var el = document.createElement("div");
    el.className = "cdb-cowork-icon-pop";
    el.setAttribute("role", "dialog");
    el.id = "cdb-cowork-icon-pop-" + (++popSeq);
    var title = document.createElement("div");
    title.className = "cdb-cowork-icon-pop-title";
    title.id = el.id + "-t";
    title.textContent = t.title;
    el.setAttribute("aria-labelledby", title.id);
    el.appendChild(title);
    var mode = document.createElement("div");
    mode.className = "cdb-cowork-icon-pop-text cdb-cowork-icon-pop-mode";
    mode.id = el.id + "-m";
    if (st === "local") readiness(mode);
    else mode.textContent = "Runs in the cloud";
    el.appendChild(mode);
    var described = [mode.id];
    var text = st === "local" ? "" : popText(st, b);
    if (text) {
      var line = document.createElement("div");
      line.className = "cdb-cowork-icon-pop-text";
      line.id = el.id + "-d";
      line.textContent = text;
      described.push(line.id);
      el.appendChild(line);
    }
    el.setAttribute("aria-describedby", described.join(" "));
    var act = document.createElement("button");
    act.type = "button";
    act.className = "cdb-cowork-icon-action";
    act.textContent = t.action;
    act.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      deepLink(t.section);
    });
    el.appendChild(act);
    document.body.appendChild(el);
    var p = { el: el, owner: b };
    p.onMove = function () {
      if (!b.isConnected) { closePop(false); return; }
      var r = b.getBoundingClientRect();
      var w = el.offsetWidth || 280;
      var vw = window.innerWidth || document.documentElement.clientWidth || 0;
      el.style.top = Math.round(r.bottom + 6) + "px";
      el.style.left = Math.round(Math.max(8, Math.min(r.left, vw - w - 8))) + "px";
    };
    p.onMove();
    b.setAttribute("aria-expanded", "true");
    b.setAttribute("aria-controls", el.id);
    p.onKey = function (ev) {
      if (ev.key !== "Escape" && ev.key !== "Esc") return;
      ev.preventDefault();
      ev.stopPropagation();
      closePop(true);
    };
    p.onDown = function (ev) {
      var n = ev.target;
      if (n && (el.contains(n) || b.contains(n))) return;
      closePop(false);
    };
    // Focus leaving the popover (Tab past its button) closes it; a click on
    // its non-focusable text (relatedTarget null) does not.
    p.onOut = function (ev) {
      var n = ev.relatedTarget;
      if (n && !el.contains(n) && !b.contains(n)) closePop(false);
    };
    document.addEventListener("keydown", p.onKey, true);
    document.addEventListener("pointerdown", p.onDown, true);
    el.addEventListener("focusout", p.onOut);
    window.addEventListener("scroll", p.onMove, true);
    window.addEventListener("resize", p.onMove);
    pop = p;
    try { act.focus({ preventScroll: true }); } catch (e) { act.focus(); }
  }
  function closePop(returnFocus) {
    if (!pop) return;
    var p = pop;
    pop = null;
    document.removeEventListener("keydown", p.onKey, true);
    document.removeEventListener("pointerdown", p.onDown, true);
    p.el.removeEventListener("focusout", p.onOut);
    window.removeEventListener("scroll", p.onMove, true);
    window.removeEventListener("resize", p.onMove);
    p.el.remove();
    p.owner.setAttribute("aria-expanded", "false");
    p.owner.removeAttribute("aria-controls");
    if (returnFocus && p.owner.isConnected) {
      try { p.owner.focus({ preventScroll: true }); } catch (e) { p.owner.focus(); }
    }
  }

  // ---- "Linux details" row in upstream's popovers ---------------------------------------
  // The button is a clone of upstream's own "Manage devices" button (classes,
  // data-cds attributes) when there is one, so it looks like its siblings.
  function detailsButton(model, section) {
    var b;
    if (model) {
      b = model.cloneNode(true);
      ["data-testid", "id", "aria-describedby", "aria-labelledby", "aria-controls", "aria-description",
        "data-popup-open", "disabled", "aria-disabled"].forEach(function (a) { b.removeAttribute(a); });
      // The label span: span.truncate, else the last span that is not a
      // design-system part (icons are [data-cds] spans). Never an icon.
      var label = b.querySelector("span.truncate");
      if (!label) {
        var spans = b.querySelectorAll("span");
        for (var si = spans.length - 1; si >= 0 && !label; si--) {
          if (!spans[si].hasAttribute("data-cds") && !spans[si].closest("[data-cds=\"Icon\"]") && !spans[si].querySelector("[data-cds]")) label = spans[si];
        }
      }
      // Drop the clone's own text; icons (elements) stay.
      var walker = document.createTreeWalker(b, 4 /* NodeFilter.SHOW_TEXT */);
      var texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      texts.forEach(function (n) { n.textContent = ""; });
      if (label) label.textContent = "Linux details";
      else {
        label = document.createElement("span");
        label.textContent = "Linux details";
        b.appendChild(label);
      }
    } else {
      b = document.createElement("button");
      b.className = "cdb-cowork-icon-action";
      b.textContent = "Linux details";
    }
    b.type = "button";
    b.classList.add("cdb-cowork-icon-details");
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      deepLink(section);
    });
    return b;
  }
  // The mode line goes into upstream's status block; the row (the "Linux
  // details" button, after a divider when there is no upstream button to sit
  // next to) is returned for the caller to place. Without a status block the
  // mode line heads the row instead.
  function detailsRow(kind, model, card) {
    var row = document.createElement("div");
    row.className = "cdb-cowork-icon-row flex flex-col";
    row.setAttribute(ATTR, "details");
    row.setAttribute("data-cdb-kind", kind);
    var mode = document.createElement("span");
    if (kind === "local") readiness(mode);
    else withVm(mode, linkedText(computerName(card)));
    if (!model) {
      var hr = document.createElement("div");
      hr.className = "my-1 h-px bg-border";
      hr.setAttribute("aria-hidden", "true");
      row.appendChild(hr);
    }
    if (!placeMode(card, mode, kind)) {
      mode.className = "cdb-cowork-icon-mode cdb-cowork-icon-line " + MODE_CLS;
      row.insertBefore(mode, row.firstChild);
    }
    row.appendChild(detailsButton(model, kind === "local" ? "local" : "cloud"));
    return row;
  }
  // The local card has no button: title block in a padded column. The row goes
  // into that column (the title span's grandparent), the card's end otherwise.
  function localContainer(card) {
    var span = card.querySelector("span");
    var block = span && span.parentNode;
    var col = block && block.parentNode;
    if (col && col !== card.parentNode && card.contains(col) && col.nodeType === 1) return col;
    return card;
  }
  // Upstream titles its card with the same text its trigger carries as
  // aria-label ("Only on this computer"; "<computer>" for "<computer>, <status>"),
  // which ties an open card to its indicator. Compared here only, never logged.
  function cardTitle(card) {
    var span = card.querySelector("span");
    return span ? String(span.textContent || "").trim() : "";
  }
  function cardOf(trigger, cards, exact) {
    var label = String(trigger.getAttribute("aria-label") || "").trim();
    if (!label) return null;
    for (var i = 0; i < cards.length; i++) {
      var t = cardTitle(cards[i]);
      if (t && (exact ? t === label : label.indexOf(t) === 0)) return cards[i];
    }
    return null;
  }
  function decorateCards() {
    var cards = document.querySelectorAll(CARD);
    var linkOpen = document.querySelector(LINK_IND + "[data-popup-open]");
    var localOpen = document.querySelector(LOCAL_IND + "[data-popup-open]");
    var bare = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.querySelector(".cdb-cowork-icon-row")) continue;
      var manage = card.querySelector(MANAGE);
      if (manage && manage.parentNode) {
        manage.parentNode.insertBefore(detailsRow("cloud", manage, card), manage.nextSibling);
        continue;
      }
      bare.push(card);
    }
    if (!localOpen && !linkOpen) return;
    if (cards.length === 0) {
      warn("no-popup", "an upstream device indicator is open (data-popup-open) but no [data-cds=\"PreviewCard\"] is in the document");
      return;
    }
    // The local card has no button of its own; the link card only lacks one
    // when upstream dropped "Manage devices".
    if (localOpen) {
      var lc = cardOf(localOpen, bare, true);
      if (lc) { var lrow = detailsRow("local", null, lc); localContainer(lc).appendChild(lrow); }
      else if (!cardOf(localOpen, cards, true)) {
        warn("no-popup", "the local-session indicator is open but no PreviewCard is titled with its aria-label");
      }
    }
    if (linkOpen) {
      var kc = cardOf(linkOpen, bare, false);
      if (kc) {
        warn("no-popup", "the computer-link popover is open but has no button[data-testid=\"cowork-computer-link-manage\"]; the row goes to its end");
        localContainer(kc).appendChild(detailsRow("cloud", null, kc));
      }
    }
  }

  // ---- scan / render ----------------------------------------------------------------
  // Fail safe against a renamed test id: any button of upstream's in the
  // trailing slot counts as its indicator, so ours never sits next to it.
  function foreignTrailing(split) {
    for (var c = split.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName !== "SPAN" || !c.classList.contains("ms-1") || ours(c)) continue;
      var bs = c.querySelectorAll("button,[role=\"button\"]");
      for (var i = 0; i < bs.length; i++) if (!ours(bs[i])) return true;
    }
    return false;
  }

  var headerMisses = 0;
  function scan() {
    var m = ROUTE.exec(location.pathname || "");
    var splits = m ? document.querySelectorAll(SPLIT) : [];
    if (m && splits.length === 0) {
      if (++headerMisses >= HEADER_MISSES) warn("no-header", "a /" + m[1] + "/ route without [data-testid=\"session-title-split\"] after " + HEADER_MISSES + " scans");
    } else headerMisses = 0;
    var want = new Set();
    for (var i = 0; i < splits.length; i++) {
      var split = splits[i];
      if (ours(split)) continue;
      var upstream = split.querySelector(LINK_IND + "," + LOCAL_IND) || foreignTrailing(split) ? "indicator"
        : split.querySelector(SLOT) ? "slot" : "none";
      var st = "none";
      var id = null;
      if (upstream === "none") {
        id = sessionIdOf(split, m[2]);
        var cloud = id.indexOf("local_") !== 0;
        st = iconState({ upstream: upstream, cloud: cloud, device: cloud ? deviceState(id) : null });
      } else st = iconState({ upstream: upstream, cloud: true, device: null });
      if (!TEXT[st]) continue;
      want.add(split);
      var b = buttons.get(split);
      if (!b) { b = makeButton(); buttons.set(split, b); }
      if (b.getAttribute("data-cdb-session") !== id) b.setAttribute("data-cdb-session", id);
      setVariant(b, st);
      place(split, b);
    }
    buttons.forEach(function (b, split) { if (!want.has(split) || !split.isConnected) unplace(split); });
    ownSlots.forEach(function (own, split) { if (!buttons.has(split)) { own.remove(); ownSlots.delete(split); } });
    decorateCards();
  }

  var pending = null;
  function schedule() {
    if (pending !== null) return;
    pending = setTimeout(function () { pending = null; scan(); }, DEBOUNCE_MS);
  }
  // Element insertions and removals only; text churn (streaming) and our own
  // nodes do not trigger a scan.
  function relevant(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (ours(r.target)) continue;
      var lists = [r.addedNodes, r.removedNodes];
      for (var l = 0; l < 2; l++) {
        for (var j = 0; j < lists[l].length; j++) {
          var n = lists[l][j];
          if (n.nodeType === 1 && !(n.matches && n.matches(OURS))) return true;
        }
      }
    }
    return false;
  }
  var observer = null;
  function start() {
    var root = document.body || document.documentElement;
    if (!root || typeof MutationObserver !== "function") { warn("no-observer", "no document body or MutationObserver"); return; }
    observer = new MutationObserver(function (records) { if (relevant(records)) schedule(); });
    observer.observe(root, { childList: true, subtree: true });
    scan();
  }

  function refresh() {
    if (!devSubscribed) devState = undefined;
    scan();
  }
  function state() {
    var list = [];
    buttons.forEach(function (b) { list.push({ variant: b.getAttribute(ATTR), session: b.getAttribute("data-cdb-session") }); });
    return {
      observing: observer !== null, icons: list, popover: pop ? pop.owner.getAttribute(ATTR) : null,
      rows: document.querySelectorAll(".cdb-cowork-icon-row").length, subscribed: devSubscribed,
      warned: Object.keys(warned)
    };
  }

  window.__cdbCoworkIconState = iconState;
  window.__cdbCoworkIcon = { refresh: refresh, state: state };
  start();
})();
