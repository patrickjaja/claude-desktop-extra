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
    rowText: ["Scheduled", "Artifacts"],
    sidebar: ['[data-testid="sidebar"]', "nav", ".df-hub-rail", ".dframe-nav-scroll"]
  };
  var ATTR = "data-cdb-jira-row";
  var ACTIVE_CLASS = "cdb-jira-row-active";
  var INTERACTIVE = "a,button,[role=button],[role=link]";
  var MODEL_STATE = ["id", "aria-current", "aria-pressed", "aria-selected", "data-state", "data-active"];
  var SVGNS = "http://www.w3.org/2000/svg";
  var MISSES_BEFORE_WARN = 30;
  // A fresh install (window.__cdbJiraWeb gone) starts with removed = false; remove() ends this copy for good.
  var removed = false, warned = {}, active = false, misses = 0, textMiss = false, frame = 0, scanTimer = 0, observer = null, resizer = null, attrs = null;
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
      else if (c.nodeType === 1 && !c.matches(INTERACTIVE)) out += ownLabel(c);
    }
    return out;
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
  function anchorRow() {
    var a = first(ANCHORS.row);
    if (a) return (ANCHORS.rowBox && a.closest(ANCHORS.rowBox)) || a;
    var rows = rowButtons();
    textMiss = rows.length > 0;
    for (var t = 0; t < ANCHORS.rowText.length; t++) {
      var hits = rows.filter(function (r) { return norm(ownLabel(r)) === ANCHORS.rowText[t]; });
      if (hits.length > 1) {
        var styled = hits.filter(function (r) { return r.matches(ANCHORS.rowClass); });
        if (styled.length) hits = styled;
      }
      if (hits.length) { textMiss = false; return rowWrapper(hits[0], rows); }
    }
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
    if (old) { old.replaceWith(icon()); return; }
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
  function build(model) {
    var row = model.cloneNode(true);
    row.setAttribute(ATTR, "1");
    var target = targetOf(row);
    var link = target.matches("a") ? target : null;
    row.querySelectorAll(INTERACTIVE).forEach(function (n) { if (n !== target && !n.contains(target)) n.remove(); });
    [row].concat(Array.prototype.slice.call(row.querySelectorAll("*"))).forEach(function (n) {
      MODEL_STATE.forEach(function (k) { n.removeAttribute(k); });
    });
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
  function scan() {
    scanTimer = 0;
    if (removed) return;
    try { place(); } catch (e) { warn("row:error", ((e && e.name) || "Error") + ": " + String((e && e.message) || "").slice(0, 120)); }
  }
  function place() {
    if (removed || ours()) return;
    var model = anchorRow();
    if (!model) {
      if (++misses === MISSES_BEFORE_WARN) {
        if (textMiss) warn("anchor:row-text", "no sidebar row is labelled Scheduled or Artifacts; the keyboard shortcut still opens the Jira page");
        else warn("anchor:sidebar", "the Artifacts row was not found; the keyboard shortcut still opens the Jira page");
      }
      return;
    }
    model.parentNode.insertBefore(build(model), model.nextSibling);
    paint();
    watchSize();
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
    var row = ours();
    if (row) row.remove();
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
    refresh: schedule,
    remove: remove,
    rect: rect,
    stats: stats
  };
  scan();
  return "jira: installed";
})();
