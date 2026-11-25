(function () {
  "use strict";
  var api = window.cdbExtra;
  if (!api || typeof api.jiraOpen !== "function") return "jira: no bridge";
  var existing = window.__cdbJiraWeb;
  if (existing && existing.version === 1) { existing.refresh(); return "jira: refreshed"; }

  var ANCHORS = {
    row: ['[data-testid="sidebar"] a[href="/artifacts"]', '[data-testid="sidebar"] a[href$="/artifacts"]'],
    rowBox: "li",
    rowButtons: '[data-testid="sidebar"] button',
    rowClass: "button.w-full.shrink-0",
    rowText: ["Scheduled", "Artifacts", "Customize", "On-call", "Meetings"],
    moreNav: '[data-testid="sidebar"] [data-nav-item="more"]',
    rowFallback: ["Search", "New"],
    sidebar: ['[data-testid="sidebar"]', "nav", ".df-hub-rail", ".dframe-nav-scroll"],
    editGroup: '[role="group"][aria-label="Choose which items appear in your sidebar."]',
    editDialogTitle: "Edit sidebar",
    moreMenuEditLabel: "Edit sidebar"
  };
  var ATTR = "data-cdb-jira-row";
  var EDIT_ATTR = "data-cdb-jira-edit-row";
  var MORE_ATTR = "data-cdb-jira-more-item";
  var ACTIVE_CLASS = "cdb-jira-row-active";
  var INTERACTIVE = "a,button,[role=button],[role=link]";
  var MODEL_STATE = ["id", "aria-current", "aria-pressed", "aria-selected", "data-state", "data-active",
    "data-nav-item", "data-selected", "data-highlighted", "aria-describedby", "aria-disabled", "data-disabled",
    "aria-expanded", "aria-haspopup"];
  var EDIT_STRIP = ["id", "for", "aria-labelledby", "aria-describedby", "disabled", "data-disabled", "aria-disabled", "name"];
  var CODE_ROUTE = /^\/(?:epitaxy|code)(?:\/|$)/;
  var CODE_EXCLUDE = /^\/code\/artifact(?:\/|$)/;
  var SVGNS = "http://www.w3.org/2000/svg";
  var MISSES_BEFORE_WARN = 30;
  // A fresh install (window.__cdbJiraWeb gone) starts with removed = false; remove() ends this copy for good.
  var removed = false, warned = {}, active = false, misses = 0, textMiss = false, frame = 0, scanTimer = 0, observer = null, resizer = null, attrs = null;
  var sidebarPinned = true;
  var sidebarLoaded = typeof api.jiraSidebarRead !== "function";
  var stats = { raf: 0, timer: 0, attr: 0, motion: 0, resize: 0 };

  function noop() {}
  function warn(key, what) {
    if (warned[key]) return;
    warned[key] = true;
    var line = "[cdb-jira] " + key + ": " + what;
    try { console.warn(line); } catch (e) {}
    try { if (typeof api.diag === "function") Promise.resolve(api.diag(line)).then(null, noop); } catch (e) {}
  }
  function first(list) {
    for (var i = 0; i < list.length; i++) {
      var n = document.querySelector(list[i]);
      if (n) return n;
    }
    return null;
  }
  function norm(s) {
    return String(s || "").normalize("NFKC").replace(/[\p{Co}\p{Cf}\p{Cc}]/gu, "").replace(/\s+/g, " ").trim();
  }
  function rowButtons() {
    return Array.prototype.filter.call(document.querySelectorAll(ANCHORS.rowButtons), function (b) {
      return !(b.parentNode && b.parentNode.closest && b.parentNode.closest("button")) && norm(ownLabel(b)) !== "";
    });
  }
  function ownLabel(node) {
    var out = "";
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1 && c.tagName !== "KBD" && !c.matches(INTERACTIVE)) out += ownLabel(c);
    }
    return out;
  }
  function fiberOf(el) {
    if (!el) return null;
    try {
      var keys = Object.keys(el);
      for (var i = 0; i < keys.length; i++) if (keys[i].indexOf("__reactFiber$") === 0) return el[keys[i]];
    } catch (e) {}
    return null;
  }
  function fiberFrameMode(side) {
    var f = fiberOf(side);
    if (!f) return "";
    for (var cur = f, i = 0; cur && i < 12; cur = cur.return, i++) {
      var p = cur.memoizedProps;
      if (p && typeof p.frameMode === "string") return p.frameMode;
    }
    for (var c = f.child, j = 0; c && j < 16; c = c.sibling, j++) {
      var cp = c.memoizedProps;
      if (cp && typeof cp.frameMode === "string") return cp.frameMode;
    }
    return "";
  }
  function onCodeTab() {
    var side = document.querySelector('[data-testid="sidebar"]');
    var mode = fiberFrameMode(side);
    if (mode) return mode === "code";
    if (side && side.closest && side.closest("aside[data-code-list]")) return true;
    if (typeof window.location === "undefined" || !window.location) return true;
    var path = String(window.location.pathname || "");
    if (window.location.protocol === "file:") {
      try {
        var testPath = document.documentElement && document.documentElement.getAttribute && document.documentElement.getAttribute("data-cdb-test-path");
        if (testPath) path = testPath;
      } catch (e) {}
    }
    if (!path) return true;
    return CODE_ROUTE.test(path) && !CODE_EXCLUDE.test(path);
  }
  function rowWrapper(btn, rows) {
    var root = first(ANCHORS.sidebar), box = btn;
    for (var n = btn.parentNode; n && n.nodeType === 1 && n !== root; n = n.parentNode) {
      var count = 0;
      for (var i = 0; i < rows.length; i++) if (n.contains(rows[i])) count++;
      if (count !== 1) break;
      box = n;
    }
    return box;
  }
  function findByLabel(rows, labels) {
    for (var t = 0; t < labels.length; t++) {
      var hits = rows.filter(function (r) { return norm(ownLabel(r)) === labels[t]; });
      if (hits.length > 1) {
        var styled = hits.filter(function (r) { return r.matches(ANCHORS.rowClass); });
        if (styled.length) hits = styled;
      }
      if (hits.length) return hits[0];
    }
    return null;
  }
  function anchorRow() {
    var a = first(ANCHORS.row);
    if (a) return { node: (ANCHORS.rowBox && a.closest(ANCHORS.rowBox)) || a, before: false };
    var rows = rowButtons();
    textMiss = rows.length > 0;
    var hit = findByLabel(rows, ANCHORS.rowText);
    if (hit) { textMiss = false; return { node: rowWrapper(hit, rows), before: false }; }
    var more = document.querySelector(ANCHORS.moreNav) || findByLabel(rows, ["More"]);
    if (more) { textMiss = false; return { node: rowWrapper(more, rows), before: true }; }
    var fb = findByLabel(rows, ANCHORS.rowFallback);
    if (fb) { textMiss = false; return { node: rowWrapper(fb, rows), before: false }; }
    return null;
  }
  function sidebar() {
    var a = first(ANCHORS.row);
    for (var i = 0; a && i < ANCHORS.sidebar.length; i++) {
      var s = a.closest(ANCHORS.sidebar[i]);
      if (s) return s;
    }
    return first(ANCHORS.sidebar);
  }
  function rect() {
    var w = window.innerWidth, h = window.innerHeight, side = sidebar();
    if (!side) {
      warn("anchor:content", "no sidebar edge found; the Jira page covers the whole view");
      return { x: 0, y: 0, width: w, height: h };
    }
    var b = side.getBoundingClientRect();
    var probe = document.elementFromPoint(b.right - 20, b.top + 60);
    var shown = !!probe && side.contains(probe);
    var x = shown ? Math.max(0, Math.min(w, Math.round(b.right))) : 0, y = Math.max(0, Math.min(h, Math.round(b.top)));
    return { x: x, y: y, width: w - x, height: h - y };
  }
  function ours() { return document.querySelector("[" + ATTR + "]"); }
  function removeAll(attr) {
    document.querySelectorAll("[" + attr + "]").forEach(function (n) { n.remove(); });
  }
  function icon() {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("width", "1em");
    svg.setAttribute("height", "1em");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", "M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5V8a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5V12a2 2 0 0 0 0-4z M8 7.5h4 M8 10h4 M8 12.5h2");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.4");
    svg.appendChild(path);
    return svg;
  }
  function textNodes(node) {
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), out = [], t;
    while ((t = walker.nextNode())) out.push(t);
    return out;
  }
  function placeIcon(target) {
    var old = target.querySelector("svg");
    if (old) {
      var next = icon(), cls = old.getAttribute("class");
      if (cls) next.setAttribute("class", cls);
      old.replaceWith(next);
      return;
    }
    var glyphs = textNodes(target).filter(function (n) { return /\p{Co}/u.test(n.nodeValue); });
    if (!glyphs.length) { target.insertBefore(icon(), target.firstChild); return; }
    var g = glyphs[0], box = g.parentNode;
    if (box !== target && norm(box.textContent) === "") {
      while (box.firstChild) box.removeChild(box.firstChild);
      box.appendChild(icon());
    } else {
      box.insertBefore(icon(), g);
    }
    glyphs.forEach(function (n) { n.nodeValue = n.nodeValue.replace(/\p{Co}/gu, ""); });
  }
  function relabel(node) {
    var done = false;
    textNodes(node).forEach(function (t) {
      if (!done && norm(t.nodeValue)) { t.nodeValue = "Jira"; done = true; }
      else if (done) t.nodeValue = "";
    });
    if (!done) node.appendChild(document.createTextNode("Jira"));
  }
  function targetOf(row) { return row.matches("a,button") ? row : row.querySelector("a,button") || row; }
  function setClass(node, name, on) {
    var list = (node.getAttribute("class") || "").split(/\s+/).filter(function (c) { return c && c !== name; });
    if (on) list.push(name);
    node.setAttribute("class", list.join(" "));
  }
  function stripAttrs(root, list) {
    [root].concat(Array.prototype.slice.call(root.querySelectorAll("*"))).forEach(function (n) {
      list.forEach(function (k) { n.removeAttribute(k); });
    });
  }
  function build(model) {
    var row = model.cloneNode(true);
    row.setAttribute(ATTR, "1");
    var target = targetOf(row);
    var link = target.matches("a") ? target : null;
    row.querySelectorAll(INTERACTIVE).forEach(function (n) { if (n !== target && !n.contains(target)) n.remove(); });
    row.querySelectorAll('kbd,[data-cds="Badge"]').forEach(function (n) { n.remove(); });
    stripAttrs(row, MODEL_STATE);
    if (link) { link.removeAttribute("href"); link.setAttribute("role", "button"); link.setAttribute("tabindex", "0"); }
    placeIcon(target);
    relabel(target);
    target.setAttribute("aria-label", "Jira");
    target.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); toggle("row"); });
    target.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle("row"); }
    });
    return row;
  }
  function paint() {
    var row = ours();
    if (!row) return;
    var target = targetOf(row);
    if (active) target.setAttribute("aria-current", "page"); else target.removeAttribute("aria-current");
    setClass(target, ACTIVE_CLASS, active);
    row.toggleAttribute("data-cdb-jira-active", active);
  }
  function syncSidebar() {
    if (!sidebarPinned) {
      removeAll(ATTR);
      misses = 0;
      return;
    }
    if (ours()) return;
    var ref = anchorRow();
    if (!ref) {
      if (++misses === MISSES_BEFORE_WARN) {
        if (textMiss) warn("anchor:row-text", "no sidebar row is labelled Scheduled or Artifacts; the keyboard shortcut still opens the Jira page");
        else warn("anchor:sidebar", "the Artifacts row was not found; the keyboard shortcut still opens the Jira page");
      }
      return;
    }
    ref.node.parentNode.insertBefore(build(ref.node), ref.before ? ref.node : ref.node.nextSibling);
    paint();
    watchSize();
  }
  function hasClass(node, name) {
    return (node.getAttribute("class") || "").split(/\s+/).indexOf(name) >= 0;
  }
  function isDisabledRow(row) {
    if (row.hasAttribute("disabled") || row.hasAttribute("data-disabled") || row.getAttribute("aria-disabled") === "true") return true;
    return !!row.querySelector('[disabled],[data-disabled],[aria-disabled="true"]');
  }
  function isCheckedRow(row) {
    if (row.hasAttribute("data-checked") || row.getAttribute("aria-checked") === "true") return true;
    if (row.querySelector('[data-checked],[aria-checked="true"]')) return true;
    var inp = row.matches('input[type="checkbox"]') ? row : row.querySelector('input[type="checkbox"]');
    return !!(inp && (inp.checked || inp.hasAttribute("checked")));
  }
  function findEditGroup() {
    var g = document.querySelector(ANCHORS.editGroup);
    if (g) return g;
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      var headings = dialogs[i].querySelectorAll('h1,h2,h3,[role="heading"]');
      var matched = false;
      for (var h = 0; h < headings.length; h++) {
        if (norm(headings[h].textContent) === ANCHORS.editDialogTitle) { matched = true; break; }
      }
      if (!matched) continue;
      var groups = dialogs[i].querySelectorAll('[role="group"]');
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].querySelector('[role="checkbox"],input[type="checkbox"]')) return groups[j];
      }
    }
    return null;
  }
  function paintEditRow(row) {
    if (!row) return;
    row.toggleAttribute("data-cdb-jira-checked", sidebarPinned);
    [row].concat(Array.prototype.slice.call(row.querySelectorAll("*"))).forEach(function (n) {
      if (n.hasAttribute("data-checked") || n.hasAttribute("data-unchecked") || n.getAttribute("role") === "checkbox" || hasClass(n, "group/cb")) {
        if (sidebarPinned) { n.setAttribute("data-checked", ""); n.removeAttribute("data-unchecked"); }
        else { n.removeAttribute("data-checked"); n.setAttribute("data-unchecked", ""); }
      }
      if (n.getAttribute("role") === "checkbox") n.setAttribute("aria-checked", sidebarPinned ? "true" : "false");
      if (n.tagName === "INPUT" && n.getAttribute("type") === "checkbox") {
        n.checked = sidebarPinned;
        n.toggleAttribute("checked", sidebarPinned);
      }
    });
  }
  function buildEditRow(model) {
    var row = model.cloneNode(true);
    row.setAttribute(EDIT_ATTR, "1");
    stripAttrs(row, EDIT_STRIP);
    var cb = row.matches('[role="checkbox"],input[type="checkbox"]') ? row : row.querySelector('[role="checkbox"],input[type="checkbox"]');
    var labelBox = null, tnodes = textNodes(row);
    for (var i = 0; i < tnodes.length; i++) {
      var tn = tnodes[i];
      if (!norm(tn.nodeValue) || (cb && cb.contains(tn.parentNode))) continue;
      var p = tn.parentNode;
      while (p && p.parentNode && p.parentNode !== row && !(cb && p.parentNode.contains(cb))) p = p.parentNode;
      if (p && !(cb && p.contains(cb))) { labelBox = p; break; }
    }
    if (labelBox) { placeIcon(labelBox); relabel(labelBox); }
    else relabel(row);
    if (cb) {
      cb.setAttribute("aria-label", "Jira");
      if (cb.tagName !== "INPUT" && !cb.hasAttribute("tabindex")) cb.setAttribute("tabindex", "0");
    }
    paintEditRow(row);
    function onToggle(ev) { ev.preventDefault(); ev.stopPropagation(); togglePinned(); }
    row.addEventListener("click", onToggle);
    row.addEventListener("keydown", function (ev) {
      if (ev.key === " " || ev.key === "Enter") onToggle(ev);
    });
    return row;
  }
  function syncEditDialog() {
    var group = findEditGroup();
    if (!group) return;
    var existingRow = group.querySelector("[" + EDIT_ATTR + "]");
    if (existingRow) { paintEditRow(existingRow); return; }
    var rows = [];
    for (var i = 0; i < group.childNodes.length; i++) {
      var ch = group.childNodes[i];
      if (ch.nodeType === 1 && (ch.matches('[role="checkbox"],input[type="checkbox"]') || ch.querySelector('[role="checkbox"],input[type="checkbox"]'))) {
        rows.push(ch);
      }
    }
    if (!rows.length) return;
    var model = rows.filter(function (r) { return !isDisabledRow(r) && isCheckedRow(r); })[0]
      || rows.filter(function (r) { return !isDisabledRow(r); })[0]
      || rows[0];
    var after = rows.filter(function (r) { return norm(r.textContent) === "Scheduled"; })[0]
      || rows.filter(function (r) { return norm(r.textContent) === "Artifacts"; })[0]
      || null;
    group.insertBefore(buildEditRow(model), after ? after.nextSibling : null);
  }
  function findMoreMenu() {
    var menus = document.querySelectorAll('[role="menu"]');
    for (var i = 0; i < menus.length; i++) {
      var items = menus[i].querySelectorAll('[role="menuitem"]');
      for (var j = 0; j < items.length; j++) {
        if (norm(ownLabel(items[j])).replace(/[\u2026.]+$/, "") === ANCHORS.moreMenuEditLabel) {
          return { menu: menus[i], items: items, editItem: items[j] };
        }
      }
    }
    return null;
  }
  function buildMoreItem(model, menu) {
    var item = model.cloneNode(true);
    item.setAttribute(MORE_ATTR, "1");
    item.querySelectorAll(INTERACTIVE).forEach(function (n) { n.remove(); });
    item.querySelectorAll('[data-cds="Badge"]').forEach(function (n) { n.remove(); });
    stripAttrs(item, MODEL_STATE);
    placeIcon(item);
    var svgs = item.querySelectorAll("svg");
    for (var i = 1; i < svgs.length; i++) svgs[i].remove();
    relabel(item);
    item.setAttribute("aria-label", "Jira");
    function activate(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        if (typeof KeyboardEvent === "function" && typeof menu.dispatchEvent === "function") {
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        }
      } catch (e) {}
      toggle();
    }
    item.addEventListener("click", activate);
    item.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") activate(ev);
    });
    return item;
  }
  function syncMoreMenu() {
    if (sidebarPinned) { removeAll(MORE_ATTR); return; }
    var found = findMoreMenu();
    if (!found || found.menu.querySelector("[" + MORE_ATTR + "]")) return;
    var model = null;
    for (var i = 0; i < found.items.length; i++) {
      if (found.items[i] !== found.editItem) { model = found.items[i]; break; }
    }
    if (!model) model = found.editItem;
    var parent = found.editItem.parentNode, sep = null;
    for (var c = 0; c < parent.childNodes.length; c++) {
      var ch = parent.childNodes[c];
      if (ch.nodeType === 1 && (ch.matches('[role="separator"]') || ch.querySelector('[role="separator"]'))) { sep = ch; break; }
    }
    parent.insertBefore(buildMoreItem(model, found.menu), sep || found.editItem);
  }
  function togglePinned() {
    sidebarPinned = !sidebarPinned;
    if (typeof api.jiraSidebarSet === "function") Promise.resolve(api.jiraSidebarSet(sidebarPinned)).then(null, noop);
    document.querySelectorAll("[" + EDIT_ATTR + "]").forEach(paintEditRow);
    if (!removed && onCodeTab()) {
      syncSidebar();
      syncMoreMenu();
    }
  }
  function sync() {
    if (!onCodeTab()) {
      removeAll(ATTR);
      removeAll(EDIT_ATTR);
      removeAll(MORE_ATTR);
      misses = 0;
      return;
    }
    if (!sidebarLoaded) return;
    syncSidebar();
    syncEditDialog();
    syncMoreMenu();
  }
  function scan() {
    scanTimer = 0;
    if (removed) return;
    try { sync(); } catch (e) { warn("row:error", ((e && e.name) || "Error") + ": " + String((e && e.message) || "").slice(0, 120)); }
  }
  function schedule() { if (!removed && !scanTimer) scanTimer = setTimeout(scan, 100); }
  function sendBounds() {
    if (active && !removed) Promise.resolve(api.jiraBounds(rect())).then(null, noop);
  }
  function onResize() {
    if (removed || frame) return;
    frame = 1;
    function go(by) { if (!frame) return; frame = 0; stats[by]++; sendBounds(); }
    requestAnimationFrame(function () { go("raf"); });
    setTimeout(function () { go("timer"); }, 50);
  }
  function onWindowResize() { stats.resize++; onResize(); }
  function onAttr() { stats.attr++; onResize(); }
  function onMotion(ev) {
    var side = sidebar();
    if (side && ev && ev.target && side.contains(ev.target)) { stats.motion++; onResize(); }
  }
  function watchSize() {
    if (removed) return;
    if (resizer) resizer.disconnect();
    resizer = new ResizeObserver(onResize);
    var side = sidebar();
    if (side) resizer.observe(side);
    resizer.observe(document.documentElement);
    if (attrs) attrs.disconnect();
    attrs = new MutationObserver(onAttr);
    for (var n = side, i = 0; n && n.nodeType === 1 && n !== document.documentElement && i < 4; n = n.parentNode, i++) attrs.observe(n, { attributes: true, attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden", "data-state"] });
  }
  function onSidebarClick(ev) {
    if (!active) return;
    var side = sidebar(), row = ours();
    if (!side || !side.contains(ev.target) || (row && row.contains(ev.target))) return;
    if (ev.target.closest && ev.target.closest("a,button,[role=button],[role=link]")) close();
  }
  function open() {
    var r = rect();
    return Promise.resolve(api.jiraOpen(r)).then(function (res) {
      if (res && res.ok) { active = true; paint(); }
      return !!(res && res.ok);
    }, function () { return false; });
  }
  function close() {
    active = false;
    paint();
    return Promise.resolve(api.jiraClose()).then(null, noop);
  }
  function toggle() { return active ? close() : open(); }
  function remove() {
    removed = true;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = 0; }
    removeAll(ATTR);
    removeAll(EDIT_ATTR);
    removeAll(MORE_ATTR);
    if (observer) observer.disconnect();
    if (resizer) resizer.disconnect();
    if (attrs) attrs.disconnect();
    observer = resizer = attrs = null;
    document.removeEventListener("click", onSidebarClick, true);
    document.removeEventListener("transitionend", onMotion, true);
    document.removeEventListener("animationend", onMotion, true);
    window.removeEventListener("resize", onWindowResize);
    active = false;
    delete window.__cdbJiraWeb;
  }

  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("click", onSidebarClick, true);
  document.addEventListener("transitionend", onMotion, true);
  document.addEventListener("animationend", onMotion, true);
  window.addEventListener("resize", onWindowResize);
  window.__cdbJiraWeb = {
    version: 1,
    open: function () { open(); return true; },
    toggle: function () { toggle(); return true; },
    setActive: function (on) { active = on === true; paint(); return true; },
    isPinned: function () { return sidebarPinned; },
    refresh: schedule,
    remove: remove,
    rect: rect,
    stats: stats
  };
  if (typeof api.jiraSidebarRead === "function") {
    Promise.resolve(api.jiraSidebarRead()).then(function (res) {
      if (res && res.ok && typeof res.pinned === "boolean") sidebarPinned = res.pinned;
      sidebarLoaded = true;
      if (!removed) scan();
    }, function () {
      sidebarLoaded = true;
      if (!removed) scan();
    });
  }
  scan();
  return "jira: installed";
})();
