/*
 * auto_archive_grace_web_page.js - the archive grace UI in the claude.ai Code
 * page (1P mode). Embedded in js/auto_archive_grace_web_main.js by
 * patches/community/add_feature_auto_archive_grace_web.nim and run in the
 * page's main world on every dom-ready. The 3P twin is js/auto_archive_grace_ui.js
 * (ion-dist, compiled into upstream's own components); this file reproduces
 * its two pieces from outside React, with the same semantics:
 *
 *   notice  a separate line right after upstream's auto-archive hold notice:
 *           minutes left / "starts at the next archive sweep" / "has ended".
 *           Upstream's notice text and live region are never touched; the line
 *           is a sibling, aria-live="off", with no role.
 *   rail    "Keep this session" right below the rail's Changes card (the
 *           aside's end when that card is not found).
 *           Sets upstream's per-session "Auto-archive on merge or close" to
 *           false through cdbExtra.autoArchiveGraceKeep (main validates the id
 *           and calls upstream's own session manager setter).
 *
 * Both render only when main reports ok + active + enabled + terminal for the
 * session. With the delay at Immediately the page does ONE read of the
 * setting and installs nothing (no observer, no timer); main re-runs this file
 * when the setting changes, which calls refresh().
 *
 * Anchors (remote claude.ai code, re-validate with baseline/AUTO_ARCHIVE_GRACE_WEB_ANCHORS.md):
 *   - the Code route: location.pathname under /epitaxy
 *   - the notice: [role="status"][aria-live="polite"] whose React fiber has an
 *     ancestor with props {hold, sessionRef}; its first host element is the
 *     notice root
 *   - the rail: an <aside> whose fiber has an ancestor with props
 *     {session, pullRequests, outputsSession}
 *   - the Changes card: a <section> in that aside whose nearest rail-card
 *     fiber props are {id:"pullRequests", title}
 *   - sessionRef / outputsSession = {type:"local", id}
 * A missing anchor logs one "[archive-grace-ui] <key>: ..." console.warn
 * (lands in claude.ai-web.log) and changes nothing.
 */
(function () {
  "use strict";
  var existing = window.__cdbArchiveGraceWeb;
  if (existing && typeof existing.refresh === "function") { existing.refresh(); return; }

  var POLL_MS = 30000;
  var RETRY_MS = 3000;
  var MAX_HOPS = 40;
  var ROUTE = /^\/epitaxy(?:\/|$)/;
  var LINE_ATTR = "data-cdb-archive-grace-line";
  var KEEP_ATTR = "data-cdb-archive-grace-keep";
  var NOTICE_HINT = /archiv/i; // every English hold text says "archive(d)"/"archiving"
  var RAIL_HINT = "Session details";

  var warned = {};
  function warn(key, what) {
    if (warned[key]) return;
    warned[key] = true;
    try { console.warn("[archive-grace-ui] " + key + ": " + what); } catch (e) {}
  }

  var on = false;          // the delay is set (or the debug override is)
  var generation = 0;      // drops a stale settings read
  var observer = null;
  var debugStatus = null;  // fake status from __cdbArchiveGraceDebug
  var sessions = new Map(); // id -> {snapshot, now, poll, busy, holdKey, kept, keeping, error}
  var notices = [];        // [{id, root, status}] from the last scan
  var rails = [];          // [{id, aside}] from the last scan
  var lines = new Map();   // notice root -> our line element
  var keeps = new Map();   // aside -> our keep box

  function bridge() {
    var b = window.cdbExtra;
    return b && typeof b.autoArchiveGraceRead === "function" ? b : null;
  }

  // ---- React fiber reads (read-only) ----------------------------------------
  function fiberOf(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactFiber$") === 0) return el[keys[i]];
    }
    return null;
  }
  function ownerWith(el, test) {
    var f = fiberOf(el);
    for (var i = 0; f && i < MAX_HOPS; i++, f = f.return) {
      var p = f.memoizedProps;
      if (p && typeof p === "object" && test(p)) return f;
    }
    return null;
  }
  function hostRoot(fiber) {
    for (var c = fiber.child, i = 0; c && i < MAX_HOPS; c = c.child, i++) {
      if (c.stateNode && c.stateNode.nodeType === 1) return c.stateNode;
    }
    return null;
  }
  function localId(ref) {
    return ref && ref.type === "local" && typeof ref.id === "string" && ref.id.length > 0 ? ref.id : undefined;
  }
  function ours(el) {
    return !!(el.closest && el.closest("[" + LINE_ATTR + "],[" + KEEP_ATTR + "]"));
  }

  function isNoticeProps(p) { return "hold" in p && "sessionRef" in p; }
  function isRailProps(p) { return "outputsSession" in p && "pullRequests" in p && "session" in p; }
  // The rail's "Changes" card: a <section> rendered by upstream's rail card
  // component with props {id:"pullRequests", title, ...}. The walk stops at the
  // first card it meets, so another card's section never matches.
  function changesSection(aside) {
    var sections = aside.querySelectorAll("section");
    for (var i = 0; i < sections.length; i++) {
      var f = fiberOf(sections[i]);
      for (var h = 0; f && h < MAX_HOPS; h++, f = f.return) {
        var p = f.memoizedProps;
        if (p && typeof p === "object" && "id" in p && "title" in p) {
          if (p.id === "pullRequests") return sections[i];
          break;
        }
      }
    }
    return null;
  }

  function findViews() {
    var found = { notices: [], rails: [], holds: new Map() };
    if (!ROUTE.test(location.pathname || "")) return found;
    var seen = new Set();
    var statuses = document.querySelectorAll('[role="status"][aria-live="polite"]');
    for (var i = 0; i < statuses.length; i++) {
      var status = statuses[i];
      if (ours(status)) continue;
      if (!fiberOf(status)) {
        if (NOTICE_HINT.test(status.textContent || "")) warn("no-fiber", "hold notice text found, but the element has no __reactFiber$ key");
        continue;
      }
      var owner = ownerWith(status, isNoticeProps);
      if (!owner) {
        if (NOTICE_HINT.test(status.textContent || "")) {
          warn("notice-props", "a role=status element mentions archiving, but no ancestor fiber within " +
            MAX_HOPS + " hops has props {hold, sessionRef}");
        }
        continue;
      }
      var props = owner.memoizedProps;
      var id = localId(props.sessionRef);
      if (id === undefined) continue; // a cloud session: upstream's notice only, as in 3P
      var root = hostRoot(owner);
      if (!root || !root.contains(status) || !root.parentNode) {
        warn("notice-root", "the {hold, sessionRef} component's first host element does not contain its role=status element");
        continue;
      }
      if (seen.has(root)) continue;
      seen.add(root);
      found.notices.push({ id: id, root: root, status: status });
      var hold = props.hold;
      found.holds.set(id, hold ? String(hold.reason) + "/" + String(hold.detail == null ? "" : hold.detail) : "");
    }
    var asides = document.querySelectorAll("aside");
    for (var j = 0; j < asides.length; j++) {
      var aside = asides[j];
      var railOwner = fiberOf(aside) ? ownerWith(aside, isRailProps) : null;
      if (!railOwner) {
        if (aside.getAttribute("aria-label") === RAIL_HINT) {
          warn("rail-props", "an aside labelled \"" + RAIL_HINT + "\" has no ancestor fiber within " + MAX_HOPS +
            " hops with props {session, pullRequests, outputsSession}");
        }
        continue;
      }
      var railId = localId(railOwner.memoizedProps.outputsSession);
      if (railId !== undefined) found.rails.push({ id: railId, aside: aside, changes: changesSection(aside) });
    }
    return found;
  }

  // ---- per-session status --------------------------------------------------
  function stopPoll(st) { if (st.poll !== null) { clearInterval(st.poll); st.poll = null; } }
  function dispose(st) { stopPoll(st); if (st.retry !== null) { clearTimeout(st.retry); st.retry = null; } }
  function terminal(id) {
    var st = sessions.get(id);
    var s = st && st.snapshot;
    return !!(s && s.ok === true && s.active === true && s.enabled === true && s.terminal === true);
  }
  // fromPoll: the 30 s poll or the one retry. A read triggered by the page
  // (mount, hold change, setting change) that finds a terminal PR without a
  // start time yet reads once more after RETRY_MS: the sweep that published
  // the hold writes the start time when it finishes.
  function read(id, fromPoll) {
    var st = sessions.get(id);
    if (!st || st.busy) return;
    st.busy = true;
    var b = bridge();
    var request = debugStatus ? Promise.resolve(debugStatus)
      : (b ? Promise.resolve().then(function () { return b.autoArchiveGraceRead(id); }) : Promise.resolve(null));
    request.then(function (v) { return v || null; }, function () { return null; }).then(function (next) {
      st.busy = false;
      if (sessions.get(id) !== st) return; // unmounted meanwhile
      st.snapshot = next;
      st.now = Date.now();
      // Poll only while the delay is set and PR auto-archive applies to this
      // session; otherwise this single read is all that runs.
      if (next && next.ok === true && next.active === true && next.enabled === true) {
        if (st.poll === null) st.poll = setInterval(function () { read(id, true); }, POLL_MS);
        if (!fromPoll && !st.retried && next.terminal === true && !Number.isSafeInteger(next.deadline)) {
          st.retried = true;
          st.retry = setTimeout(function () { st.retry = null; read(id, true); }, RETRY_MS);
        }
      } else stopPoll(st);
      render();
    });
  }

  function remaining(deadline, now) {
    var minutes = Math.ceil((deadline - now) / 60000);
    if (minutes < 60) return minutes + " min";
    var hours = Math.floor(minutes / 60), rest = minutes % 60;
    return rest === 0 ? hours + " h" : hours + " h " + rest + " min";
  }
  function lineText(st) {
    var d = st.snapshot.deadline;
    if (!Number.isSafeInteger(d)) return "The PR auto-archive delay starts at the next archive sweep.";
    return d > st.now ? "The PR auto-archive delay has about " + remaining(d, st.now) + " left."
      : "The PR auto-archive delay has ended.";
  }
  function lineClass(view) {
    if (view.status === view.root) return view.status.className;
    var outer = String(view.root.className || "").split(/\s+/).filter(function (c) {
      return c.indexOf("text-") === 0 || c === "max-w-full";
    });
    return outer.concat(String(view.status.className || "").split(/\s+/)).filter(Boolean).join(" ");
  }

  // ---- DOM writes (ours only; every write is skipped when already in place) -
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function setAttr(el, name, value) { if (el.getAttribute(name) !== value) el.setAttribute(name, value); }

  function placeLine(view, st) {
    var line = lines.get(view.root);
    if (!line) {
      line = document.createElement("div");
      line.setAttribute(LINE_ATTR, "");
      line.setAttribute("aria-live", "off");
      line.setAttribute("data-find-omitted", "");
      lines.set(view.root, line);
    }
    setAttr(line, "data-session", view.id);
    var cls = lineClass(view);
    if (line.className !== cls) line.className = cls;
    setText(line, lineText(st));
    if (view.root.nextSibling !== line) view.root.parentNode.insertBefore(line, view.root.nextSibling);
  }

  function keepBox(aside, id) {
    var box = keeps.get(aside);
    if (box && box.getAttribute("data-session") === id) return box;
    if (box) box.remove();
    box = document.createElement("div");
    box.setAttribute(KEEP_ATTR, "");
    box.setAttribute("data-session", id);
    box.className = "flex flex-col gap-1 px-2 py-1";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "text-footnote text-muted-as-secondary hover:text-text-primary text-left";
    button.title = "Turns off Auto-archive on merge or close for this session, the same setting as in the PR menu";
    button.addEventListener("click", function () { keep(id); });
    box.appendChild(button);
    keeps.set(aside, box);
    return box;
  }
  function placeKeep(view, st) {
    var box = keepBox(view.aside, view.id);
    // Right below the Changes card (the PR rows); the aside's end otherwise.
    var changes = view.changes && view.changes.parentNode && view.aside.contains(view.changes) ? view.changes : null;
    if (!changes) warn("rail-changes", "no section in the Session details aside resolves to the rail card with id \"pullRequests\"; the keep button goes to the end of the aside");
    var button = box.firstChild;
    setText(button, st.keeping ? "Keeping session..." : "Keep this session");
    if (button.disabled !== st.keeping) button.disabled = st.keeping;
    var alert = box.childNodes[1] || null;
    if (st.error) {
      if (!alert) { alert = document.createElement("span"); alert.setAttribute("role", "alert"); alert.className = "text-footnote"; box.appendChild(alert); }
      setText(alert, st.error);
    } else if (alert) alert.remove();
    if (changes) { if (changes.nextSibling !== box) changes.parentNode.insertBefore(box, changes.nextSibling); }
    else if (view.aside.lastChild !== box) view.aside.appendChild(box);
  }

  function keep(id) {
    var st = sessions.get(id);
    if (!st || st.keeping) return;
    st.keeping = true;
    st.error = "";
    render();
    var b = window.cdbExtra;
    var request;
    if (debugStatus && debugStatus.realKeep !== true) {
      warn("debug-keep", "debug status active: keep(" + id + ", false) was not sent");
      request = Promise.resolve({ ok: true });
    } else if (b && typeof b.autoArchiveGraceKeep === "function") {
      request = Promise.resolve().then(function () { return b.autoArchiveGraceKeep(id); });
    } else request = Promise.resolve({ ok: false });
    request.then(function (r) { return r && r.ok === true; }, function () { return false; }).then(function (ok) {
      st.keeping = false;
      // The button stays hidden for this session even if a read still sees
      // the old value before upstream's save lands.
      if (ok) st.kept = true;
      else st.error = "Could not keep this session. Try again.";
      render();
    });
  }

  function render() {
    var wantLines = new Set(), wantKeeps = new Set();
    var canKeep = !!(debugStatus || (window.cdbExtra && typeof window.cdbExtra.autoArchiveGraceKeep === "function"));
    for (var i = 0; i < notices.length; i++) {
      var n = notices[i];
      if (!n.root.isConnected || !terminal(n.id)) continue;
      wantLines.add(n.root);
      placeLine(n, sessions.get(n.id));
    }
    for (var j = 0; j < rails.length; j++) {
      var r = rails[j], st = sessions.get(r.id);
      if (!canKeep || !r.aside.isConnected || !terminal(r.id) || st.kept) continue;
      wantKeeps.add(r.aside);
      placeKeep(r, st);
    }
    lines.forEach(function (line, root) { if (!wantLines.has(root)) { line.remove(); lines.delete(root); } });
    keeps.forEach(function (box, aside) { if (!wantKeeps.has(aside)) { box.remove(); keeps.delete(aside); } });
  }

  function scan() {
    if (!on) return;
    var found = findViews();
    notices = found.notices;
    rails = found.rails;
    var live = new Set();
    notices.forEach(function (n) { live.add(n.id); });
    rails.forEach(function (r) { live.add(r.id); });
    // Unmount: a session with neither a notice nor a rail on screen.
    sessions.forEach(function (st, id) { if (!live.has(id)) { dispose(st); sessions.delete(id); } });
    live.forEach(function (id) {
      var holdKey = found.holds.has(id) ? found.holds.get(id) : null;
      var st = sessions.get(id);
      if (!st) {
        st = { snapshot: null, now: Date.now(), poll: null, retry: null, retried: false, busy: false, holdKey: holdKey,
          kept: false, keeping: false, error: "" };
        sessions.set(id, st);
        read(id);
      } else if (holdKey !== null && holdKey !== st.holdKey) {
        // Same as the 3P view: a different hold is a fresh mount.
        st.holdKey = holdKey;
        st.snapshot = null;
        read(id);
      }
    });
    render();
  }

  function start() {
    if (!observer) {
      var root = document.body || document.documentElement;
      if (!root || typeof MutationObserver !== "function") { warn("no-observer", "no document body or MutationObserver"); return; }
      observer = new MutationObserver(scan);
      observer.observe(root, { childList: true, subtree: true });
    }
    scan();
  }
  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    sessions.forEach(dispose);
    sessions.clear();
    notices = []; rails = [];
    render();
  }

  // One settings read; the observer exists only while the delay is set.
  function refresh() {
    var mine = ++generation;
    if (debugStatus) { on = true; start(); return Promise.resolve(true); }
    var b = bridge();
    if (!b) { warn("no-bridge", "window.cdbExtra.autoArchiveGraceRead is missing (mainView preload not patched?)"); on = false; stop(); return Promise.resolve(false); }
    return Promise.resolve().then(function () { return b.autoArchiveGraceRead(); }).then(null, function () { return null; })
      .then(function (s) {
        if (mine !== generation) return on;
        on = !!(s && s.ok === true && typeof s.minutes === "number" && s.minutes > 0);
        if (on) {
          // A changed delay changes every deadline: read each session again.
          sessions.forEach(function (st, id) { read(id); });
          start();
        } else stop();
        return on;
      });
  }

  function state() {
    return {
      on: on, observing: observer !== null, debug: debugStatus !== null,
      notices: notices.map(function (n) { return n.id; }),
      rails: rails.map(function (r) { return r.id; }),
      sessions: Array.from(sessions.keys()).map(function (id) {
        var st = sessions.get(id);
        return { id: id, snapshot: st.snapshot, polling: st.poll !== null, kept: st.kept };
      }),
      lines: lines.size, keeps: keeps.size, warned: Object.keys(warned)
    };
  }

  window.__cdbArchiveGraceWeb = { refresh: refresh, state: state };

  // Live-check aid, only with localStorage.cdbArchiveGraceDebug === "1":
  // __cdbArchiveGraceDebug({deadline: Date.now() + 600000}) renders against a
  // fake terminal status for every local session on screen; null clears it.
  // The keep button only logs unless the fake status says realKeep: true.
  var debugOn = false;
  try { debugOn = window.localStorage.getItem("cdbArchiveGraceDebug") === "1"; } catch (e) {}
  if (debugOn) {
    window.__cdbArchiveGraceDebug = function (fake) {
      debugStatus = fake ? {
        ok: true, active: true, enabled: true, terminal: true,
        deadline: Number.isSafeInteger(fake.deadline) ? fake.deadline : null,
        realKeep: fake.realKeep === true
      } : null;
      sessions.forEach(dispose);
      sessions.clear();
      lines.forEach(function (line) { line.remove(); });
      lines.clear();
      keeps.forEach(function (box) { box.remove(); });
      keeps.clear();
      return refresh().then(function () { return state(); });
    };
  }

  refresh();
})();
