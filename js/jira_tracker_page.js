(function () {
  "use strict";
  var api = window.cdbJira, adf = window.__cdbJiraAdf;
  if (!api || !adf || !document.getElementById("cdb-jira-root")) return;
  var STALE_MS = 60000;
  var PRESETS = [["assigned", "Assigned to me"], ["reported", "Reported by me"]];
  var SECTIONS = [["board", "Board"], ["backlog", "Backlog"], ["done", "Done"]];
  var COMMENTS_SHOWN = 5;
  var STACKED_BELOW = 720;
  var SEND_GLYPH = "M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z";
  var INLINE = { "image/png": "image", "image/jpeg": "image", "image/gif": "image", "image/webp": "image", "video/mp4": "video", "video/webm": "video" };
  var INLINE_MAX = { image: 10485760, video: 52428800 };
  var AVATAR_COLORS = 6;
  var PRIORITY_GLYPHS = { up: "M4 10l4-4 4 4", up2: "M4 8l4-4 4 4M4 12l4-4 4 4", mid: "M4 6.5h8M4 9.5h8", down: "M4 6l4 4 4-4", down2: "M4 4l4 4 4-4M4 8l4 4 4-4" };
  var SORTS = [["updated", "Updated"], ["priority", "Priority"], ["created", "Created"], ["key", "Key"]];
  var SVGNS = "http://www.w3.org/2000/svg";
  var GLYPHS = {
    bug: "M8 4.5a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-5 0V7A2.5 2.5 0 0 1 8 4.5zM8 7v5.5M3 8h2.5M10.5 8H13M4 4.5l2 1.5M12 4.5l-2 1.5M4 12.5l1.7-1.2M12 12.5l-1.7-1.2",
    story: "M4.5 2.5h7v11L8 11l-3.5 2.5z",
    epic: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z",
    task: "M3 3h10v10H3zM5.5 8.2l1.8 1.8 3.4-3.6",
    other: "M8 3a5 5 0 1 1 0 10A5 5 0 0 1 8 3z"
  };
  var st = { source: "assigned", lastTab: "assigned", project: "", projects: [], jql: "", queries: [], records: [], next: "", loadedAt: 0, loading: false, detail: "", pending: {}, view: "list", sort: "updated", sortChosen: false, jqlMode: false, detailsOpen: true, detailsOpenStacked: false, blobs: [], statusColumns: {}, expanded: {}, childCache: {}, boards: {}, notice: "", noticeShown: false };
  var menu = null, menuOwner = null, themeKeys = [];

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function button(text, fn, cls) {
    var b = el("button", cls || "", text);
    b.type = "button";
    b.addEventListener("click", function (ev) { ev.stopPropagation(); fn(b, ev); });
    return b;
  }
  function svg(d, stroke) {
    var s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", stroke || "1.4");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }
  function glyphFor(type) {
    var t = String(type || "").toLowerCase();
    if (t.indexOf("bug") >= 0) return GLYPHS.bug;
    if (t.indexOf("story") >= 0) return GLYPHS.story;
    if (t.indexOf("epic") >= 0) return GLYPHS.epic;
    if (t.indexOf("task") >= 0) return GLYPHS.task;
    return GLYPHS.other;
  }
  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    return parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() : "-";
  }
  function ago(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var diff = Math.round((Date.now() - t) / 60000), m = Math.abs(diff);
    if (m < 10080) {
      if (m < 1) return "just now";
      var n = m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d";
      return diff >= 0 ? n + " ago" : "in " + n;
    }
    var d = new Date(t), opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }
  function fullDate(iso) {
    var t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleString() : "";
  }
  function dateText(iso, cls) {
    var v = el("span", cls || "", ago(iso));
    v.title = fullDate(iso);
    return v;
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    if (menuOwner) { menuOwner.setAttribute("aria-expanded", "false"); menuOwner = null; }
  }
  function menuButtons() { return menu ? Array.prototype.slice.call(menu.querySelectorAll("button:not([disabled])")) : []; }
  function popMenu(owner, role) {
    closeMenu();
    menu = el("div", "menu");
    menu.setAttribute("role", role);
    menuOwner = owner;
    owner.setAttribute("aria-expanded", "true");
    var r = owner.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 240)) + "px";
    menu.style.top = (r.bottom + 4) + "px";
    document.body.appendChild(menu);
    menu.addEventListener("keydown", function (ev) {
      var opts = menuButtons(), i = opts.indexOf(document.activeElement);
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        var next = ev.key === "ArrowDown" ? Math.min(opts.length - 1, i + 1) : Math.max(0, i - 1);
        if (opts[next]) opts[next].focus();
      } else if (ev.key === "Home" || ev.key === "End") {
        ev.preventDefault();
        if (opts.length) opts[ev.key === "Home" ? 0 : opts.length - 1].focus();
      } else if (ev.key === "Escape" || ev.key === "Tab") {
        ev.preventDefault(); ev.stopPropagation(); closeMenu(); owner.focus();
      } else if ((ev.key === "Enter" || ev.key === " ") && i >= 0) {
        ev.preventDefault(); opts[i].click();
      }
    });
    return menu;
  }
  function fillMenu(m, entries, itemRole) {
    clear(m);
    entries.forEach(function (e) {
      if (e.note) { m.appendChild(el("div", "note", e.note)); return; }
      if (e.sep) { m.appendChild(el("div", "sep")); return; }
      var b = button(e.label, function () { e.fn(b); });
      b.setAttribute("role", itemRole);
      if (e.selected !== undefined) b.setAttribute("aria-selected", String(!!e.selected));
      if (e.disabled) { b.disabled = true; if (e.title) b.title = e.title; }
      if (e.hint) b.appendChild(el("div", "note", e.hint));
      m.appendChild(b);
    });
    var sel = m.querySelector('button[aria-selected="true"]:not([disabled])') || menuButtons()[0];
    if (sel) sel.focus();
  }
  function opaque(c) { var s = String(c || "").trim(); return /^(transparent|rgba\([^)]*,\s*0\))$/i.test(s) ? "" : s; }
  function applyTheme(t) {
    if (!t || typeof t !== "object") return;
    var root = document.documentElement, vars = t.vars && typeof t.vars === "object" ? t.vars : {};
    var keys = Object.keys(vars).filter(function (k) { return /^--cds-[A-Za-z0-9_-]+$/.test(k) && typeof vars[k] === "string"; });
    themeKeys.forEach(function (k) { if (keys.indexOf(k) < 0) root.style.removeProperty(k); });
    keys.forEach(function (k) { root.style.setProperty(k, vars[k]); });
    themeKeys = keys;
    [["--jira-host-bg", opaque(t.bg)], ["--jira-host-fg", String(t.fg || "")], ["--jira-host-font", String(t.font || "")]].forEach(function (p) {
      if (p[1]) root.style.setProperty(p[0], p[1]); else root.style.removeProperty(p[0]);
    });
    root.style.colorScheme = /^(light|dark|light dark|dark light|normal)$/.test(String(t.scheme || "")) ? t.scheme : "";
    if (t.scheme === "light" || t.scheme === "dark") root.setAttribute("data-scheme", t.scheme); else root.removeAttribute("data-scheme");
  }

  function resultsCol() {
    var box = $("results");
    clear(box);
    return box.appendChild(el("div", "col"));
  }
  function problem(box, res, retry) {
    clear(box);
    if (box === $("results")) box = box.appendChild(el("div", "col"));
    var wrap = el("div", res && res.kind === "config" ? "empty" : "error", (res && (res.message || res.error)) || "Something went wrong.");
    var actions = el("div");
    if (res && (res.kind === "config" || res.kind === "auth" || res.kind === "forbidden")) actions.appendChild(button("Open settings", function () { api.openSettings(); }));
    if (res && res.retry && retry) actions.appendChild(button("Retry", retry));
    wrap.appendChild(actions);
    box.appendChild(wrap);
  }

  function query() {
    var q;
    if (st.source === "jql") q = { jql: st.jql };
    else if (st.source.indexOf("q:") === 0) {
      var name = st.source.slice(2);
      var saved = st.queries.filter(function (x) { return x.name === name; })[0];
      q = { jql: saved ? saved.jql : "" };
    } else return { preset: st.source, project: st.project, sort: st.sort };
    if (st.sortChosen) q.sort = st.sort;
    return q;
  }
  function tabItems() {
    return PRESETS.map(function (p) { return { value: p[0], label: p[1] }; })
      .concat(st.queries.map(function (q) { return { value: "q:" + q.name, label: q.name }; }));
  }
  function projectItems() {
    return [{ value: "", label: "All projects" }].concat((st.projects || []).map(function (x) { return { value: x.key, label: x.key + " — " + x.name }; }));
  }
  function projectLabel() {
    var it = projectItems().filter(function (i) { return i.value === st.project; })[0];
    return it ? (it.value || it.label) : "All projects";
  }
  function selectTab(value) {
    st.source = value;
    if (value !== "jql") { st.lastTab = value; $("jql").value = ""; }
    fillSources();
    load(false);
  }
  function fillSources() {
    var items = tabItems();
    if (st.source !== "jql" && !items.some(function (i) { return i.value === st.source; })) st.source = st.lastTab = "assigned";
    var tabs = $("tabs");
    clear(tabs);
    items.forEach(function (it) {
      var on = it.value === st.source;
      var b = button(it.label, function () { selectTab(it.value); }, "tab");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on || (st.source === "jql" && it.value === st.lastTab) ? 0 : -1;
      b.setAttribute("data-value", it.value);
      tabs.appendChild(b);
    });
    fillTools();
  }
  function fillTools() {
    var preset = st.source !== "jql" && st.source.indexOf("q:") !== 0;
    var f = $("filter");
    f.disabled = !preset;
    f.title = preset ? "Project" : "Project applies to the preset tabs only";
    f.setAttribute("aria-label", "Project: " + projectLabel());
    var dot = f.querySelector(".dot");
    if (st.project && !dot) f.appendChild(el("span", "dot"));
    else if (!st.project && dot) dot.remove();
    var label = SORTS.filter(function (x) { return x[0] === st.sort; })[0];
    $("sort").setAttribute("aria-label", "Sort: " + (label ? label[1] : "Updated"));
  }
  function looksLikeJql(text) { return /[=~<>!]|\b(order\s+by|and|or|not|in|is|was)\b/i.test(text); }
  function runSearch() {
    var text = $("jql").value.trim();
    if (!text) { selectTab(st.lastTab); return; }
    st.jql = st.jqlMode || looksLikeJql(text) ? text : 'text ~ "' + text.replace(/["\\]/g, "\\$&") + '" ORDER BY updated DESC';
    st.source = "jql";
    fillSources();
    load(false);
  }

  var loadGen = 0;
  function load(more) {
    if (more && st.loading) return;
    var q = query(), gen = ++loadGen;
    st.loading = false;
    if (q.jql === "") { resultsCol().appendChild(el("div", "empty", "Type a search or a JQL query and press Enter.")); return; }
    st.loading = true;
    if (!more) resultsCol().appendChild(el("div", "empty", "Loading..."));
    api.search(q, more ? st.next : "").then(function (res) {
      if (gen !== loadGen) return;
      st.loading = false;
      if (!res || !res.ok) { problem($("results"), res, function () { load(more); }); return; }
      st.records = more ? st.records.concat(res.records) : res.records;
      if (!more) st.childCache = {};
      st.next = res.nextPageToken || "";
      st.boards = more ? Object.assign({}, st.boards, res.boards || {}) : res.boards || {};
      st.statusColumns = more ? Object.assign({}, st.statusColumns, res.statusColumns || {}) : res.statusColumns || {};
      st.notice = "";
      if (res.agileNotice && !st.noticeShown) { st.noticeShown = true; st.notice = "Board/Backlog needs Jira Software access; showing by status."; }
      st.loadedAt = Date.now();
      render();
    }, function (e) { if (gen !== loadGen) return; st.loading = false; problem($("results"), { message: String(e) }); });
  }
  function nestedKeys() {
    var nested = {};
    st.records.forEach(function (r) { (r.subtasks || []).forEach(function (x) { nested[x.key] = true; }); });
    return nested;
  }
  function countText(n) { return n + (st.next ? "+" : ""); }
  function render() {
    var box = resultsCol();
    if (st.notice) box.appendChild(el("div", "notice", st.notice));
    if (!st.records.length) { box.appendChild(el("div", "empty", "No tickets match.")); return; }
    if (st.view === "board") renderBoard(box);
    else {
      var nested = nestedKeys();
      SECTIONS.forEach(function (g) {
        var recs = st.records.filter(function (r) { return sectionOf(r) === g[0] && !nested[r.key]; });
        if (!recs.length) return;
        var sec = box.appendChild(el("section", "section"));
        sec.setAttribute("aria-label", g[1]);
        var head = sec.appendChild(el("h2", "group", g[1]));
        head.appendChild(el("span", "count", countText(recs.length)));
        var list = sec.appendChild(el("div", "rows"));
        recs.forEach(function (rec) {
          list.appendChild(row(rec));
          if ((rec.subtasks || []).length && st.expanded[rec.key]) list.appendChild(childRows(rec));
        });
      });
    }
    if (st.next) box.appendChild(button("Load more", function () { load(true); }, "more-results"));
  }
  var CATEGORY_ORDER = { todo: 0, inprogress: 1, done: 2 };
  function boardColumns(recs) {
    var projects = recs.map(function (r) { return r.project; }).filter(function (p, i, a) { return p && a.indexOf(p) === i; });
    var info = projects.length === 1 ? st.boards[projects[0]] : null;
    var cols;
    var flow = projects.length === 1 ? st.statusColumns[projects[0]] : null;
    if (info && Array.isArray(info.columns) && info.columns.length) cols = info.columns.map(function (c) { return { name: c.name, statusIds: c.statusIds.slice() }; });
    else if (Array.isArray(flow) && flow.length) cols = flow.map(function (c) { return { name: c.name, statusIds: c.statusIds.slice() }; });
    else {
      var seen = {};
      recs.forEach(function (r) { if (r.statusId && !seen[r.statusId]) seen[r.statusId] = { name: r.status || r.statusId, statusIds: [r.statusId], cat: r.category || "todo" }; });
      cols = Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) {
        return (CATEGORY_ORDER[a.cat] - CATEGORY_ORDER[b.cat]) || a.name.localeCompare(b.name);
      }).map(function (c) { return { name: c.name, statusIds: c.statusIds }; });
    }
    cols.forEach(function (c) { c.records = recs.filter(function (r) { return c.statusIds.indexOf(r.statusId) >= 0; }); });
    var other = recs.filter(function (r) { return !cols.some(function (c) { return c.statusIds.indexOf(r.statusId) >= 0; }); });
    if (other.length) cols.push({ name: "Other", statusIds: [], records: other });
    return cols;
  }
  function renderBoard(box) {
    var onBoard = st.records.filter(function (r) { return sectionOf(r) !== "backlog"; });
    var nested = nestedKeys();
    var backlog = st.records.filter(function (r) { return sectionOf(r) === "backlog" && !nested[r.key]; }).length;
    var top = box.appendChild(el("div", "board-top"));
    var title = top.appendChild(el("h2", "group board-title", "Board"));
    title.appendChild(el("span", "count", countText(onBoard.length)));
    if (backlog) {
      var link = button("Backlog " + countText(backlog) + " →", function () {
        setView("list");
        var sec = document.querySelector('section[aria-label="Backlog"]');
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "start" });
      }, "linkish muted backlog-link");
      link.id = "board-backlog";
      link.setAttribute("aria-label", st.next ? "Show the " + backlog + "+ backlog tickets loaded so far in the list" : "Show the " + backlog + " backlog ticket" + (backlog === 1 ? "" : "s") + " in the list");
      top.appendChild(link);
    }
    var wrap = box.appendChild(el("div", "boardwrap"));
    var board = wrap.appendChild(el("div", "board"));
    boardColumns(onBoard).forEach(function (c) {
      var col = board.appendChild(el("section", "column"));
      col.setAttribute("aria-label", c.name);
      col.__cdbColumn = c;
      var h = col.appendChild(el("h3", "", c.name));
      h.appendChild(el("span", "count", String(c.records.length)));
      c.records.forEach(function (r) { col.appendChild(card(r, c)); });
    });
  }
  function boardColumnsOnScreen() {
    return Array.prototype.map.call(document.querySelectorAll(".board .column"), function (n) { return n.__cdbColumn; }).filter(Boolean);
  }
  function card(rec, col) {
    var n = el("div", "card" + (st.pending[rec.key] ? " pending" : ""));
    n.setAttribute("data-key", rec.key);
    n.setAttribute("role", "button");
    n.tabIndex = 0;
    var topRow = n.appendChild(el("div", "ctop"));
    topRow.appendChild(svg(glyphFor(rec.type)));
    topRow.appendChild(el("span", "ckey", rec.key));
    if (st.pending[rec.key]) topRow.appendChild(el("span", "", "pending..."));
    var more = button("", function (b) { cardMenu(rec, col, b); }, "icon more");
    more.appendChild(svg("M4 8h.01M8 8h.01M12 8h.01", "2.2"));
    more.setAttribute("aria-label", "Actions for " + rec.key);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    topRow.appendChild(more);
    n.appendChild(el("div", "csum", rec.summary));
    var foot = n.appendChild(el("div", "cfoot"));
    if (col && col.statusIds.length !== 1) {
      var cst = foot.appendChild(el("span", "pill cstatus", rec.status));
      cst.setAttribute("data-cat", rec.category);
    }
    if (rec.priority) { foot.appendChild(priorityGlyph(rec.priority)); foot.appendChild(el("span", "", rec.priority)); }
    if (rec.assignee) { var av = avatar(rec.assignee); av.title = rec.assignee; foot.appendChild(av); }
    n.addEventListener("click", function () { if (!dragState.justDropped) showDetail(rec.key); });
    n.addEventListener("keydown", function (ev) {
      if (ev.target !== n) return;
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showDetail(rec.key); }
    });
    n.addEventListener("pointerdown", function (ev) { dragStart(ev, n, rec, col); });
    return n;
  }
  function cardMenu(rec, col, anchor) {
    if (menu && menuOwner === anchor) { closeMenu(); return; }
    var m = popMenu(anchor, "menu");
    function top() {
      fillMenu(m, [
        { label: "Open in Jira", fn: function () { closeMenu(); api.openIssue(rec.key); } },
        { label: "Send to agent", fn: function () { closeMenu(); sendToAgent(rec, null); } },
        { label: "Move to column ›", fn: columns }
      ], "menuitem");
    }
    function columns() {
      var entries = [{ label: "‹ Back", fn: top }];
      boardColumnsOnScreen().forEach(function (c) {
        if (c === col || !c.statusIds.length) return;
        entries.push({ label: c.name, fn: function () { closeMenu(); runDrop(rec, c, null); } });
      });
      fillMenu(m, entries, "menuitem");
    }
    top();
  }
  var dragState = { on: false, justDropped: false };
  var dragStats = { down: 0, move: 0, moveButtons: 0, started: 0, capture: 0, hits: 0, lastHit: "", drops: 0, cancels: 0 };
  window.__cdbJiraDragStats = dragStats;
  function dragStart(ev, n, rec, col) {
    dragStats.down++;
    if (ev.button !== 0 || st.pending[rec.key] || (ev.target.closest && ev.target.closest(".more"))) return;
    var d = { n: n, rec: rec, col: col, x: ev.clientX, y: ev.clientY, id: ev.pointerId, ghost: null, target: null, timer: 0 };
    try { n.setPointerCapture(ev.pointerId); dragStats.capture++; } catch (e) {}
    function move(e) {
      if (e.pointerId !== undefined && d.id !== undefined && e.pointerId !== d.id) return;
      dragStats.move++;
      if (e.buttons) dragStats.moveButtons++;
      if (!d.ghost) {
        if (Math.abs(e.clientX - d.x) < 4 && Math.abs(e.clientY - d.y) < 4) return;
        var r = n.getBoundingClientRect();
        d.dx = d.x - r.left; d.dy = d.y - r.top;
        d.ghost = n.cloneNode(true);
        d.ghost.classList.add("ghost");
        d.ghost.style.width = r.width + "px";
        document.body.appendChild(d.ghost);
        n.classList.add("dragging");
        dragState.on = true;
        dragStats.started++;
        closeMenu();
      }
      d.ghost.style.left = (e.clientX - d.dx) + "px";
      d.ghost.style.top = (e.clientY - d.dy) + "px";
      var hit = document.elementFromPoint(e.clientX, e.clientY);
      var target = hit && hit.closest ? hit.closest(".board .column") : null;
      if (target) { dragStats.hits++; dragStats.lastHit = target.getAttribute("aria-label") || ""; }
      if (target !== d.target) {
        if (d.target) d.target.classList.remove("drop");
        d.target = target && target.__cdbColumn !== d.col && target.__cdbColumn.statusIds.length ? target : null;
        if (d.target) d.target.classList.add("drop");
      }
      var wrap = document.querySelector(".boardwrap");
      if (wrap) {
        var wr = wrap.getBoundingClientRect();
        d.edge = e.clientX < wr.left + 48 ? -1 : e.clientX > wr.right - 48 ? 1 : 0;
        if (d.edge && !d.timer) d.timer = setInterval(function () { if (d.edge) wrap.scrollLeft += d.edge * 24; }, 30);
      }
    }
    function end(e, cancel) {
      if (e && e.pointerId !== undefined && d.id !== undefined && e.type !== "keydown" && e.pointerId !== d.id) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancelled, true);
      document.removeEventListener("keydown", esc, true);
      if (d.timer) clearInterval(d.timer);
      try { n.releasePointerCapture(d.id); } catch (x) {}
      var dragged = !!d.ghost, target = d.target;
      if (d.ghost) d.ghost.remove();
      if (target) target.classList.remove("drop");
      n.classList.remove("dragging");
      dragState.on = false;
      if (dragged) { dragState.justDropped = true; setTimeout(function () { dragState.justDropped = false; }, 0); }
      if (dragged && cancel) dragStats.cancels++;
      if (dragged && !cancel && target) { dragStats.drops++; runDrop(rec, target.__cdbColumn, { x: e.clientX, y: e.clientY }); }
    }
    function up(e) { end(e, false); }
    function cancelled(e) { end(e, true); }
    function esc(e) { if (e.key === "Escape" && d.ghost) { e.preventDefault(); e.stopPropagation(); end(e, true); } }
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancelled, true);
    document.addEventListener("keydown", esc, true);
  }
  function runDrop(rec, col, at, transitionId) {
    st.pending[rec.key] = true;
    render();
    return api.drop(rec.key, col.statusIds, transitionId || "").then(function (res) {
      delete st.pending[rec.key];
      if (!res || !res.ok) { render(); alertLine((res && (res.message || res.error)) || "The move failed."); return res; }
      if (res.kind === "done" && res.record) {
        st.records = st.records.map(function (x) { return x.key === rec.key ? Object.assign({}, x, res.record, { place: x.place, boardId: x.boardId, sprint: x.sprint, project: x.project || res.record.project }) : x; });
        render();
        if (st.detail === rec.key) showDetail(rec.key);
      } else if (res.kind === "choose") {
        render();
        var anchor = document.querySelector('.card[data-key="' + rec.key + '"]');
        if (!anchor) return res;
        var m = popMenu(anchor, "menu");
        if (at) { m.style.left = Math.max(4, Math.min(at.x, window.innerWidth - 240)) + "px"; m.style.top = (at.y + 4) + "px"; }
        fillMenu(m, [{ note: "Move " + rec.key + " with" }].concat(res.options.map(function (o) {
          return { label: o.name + (o.toStatus && o.toStatus !== o.name ? " → " + o.toStatus : ""), fn: function () { closeMenu(); runDrop(rec, col, null, o.id); } };
        })), "menuitem");
      } else { render(); alertLine(res.message || "That move is not possible."); }
      return res;
    });
  }
  function sectionOf(rec) {
    if (rec.category === "done") return "done";
    if (rec.place === "board" || rec.place === "backlog") return rec.place;
    return rec.sprint || rec.category === "inprogress" ? "board" : "backlog";
  }
  function placed(key) { return st.records.filter(function (r) { return r.key === key; })[0] || null; }
  function moveEntry(rec) {
    var r = placed(rec.key);
    if (!r || !r.place || !r.boardId || r.category === "done") return null;
    if (r.place === "board") return { label: "Move to backlog", to: "backlog", rec: r };
    var info = st.boards[r.project];
    if (info && info.noSprint) return { label: "Move to board", to: "board", rec: r, disabled: true, title: "No active sprint" };
    return { label: "Move to board", to: "board", rec: r };
  }
  function runMove(r, to) {
    st.pending[r.key] = true;
    render();
    return api.move(r.key, to, r.boardId).then(function (res) {
      delete st.pending[r.key];
      if (res && res.ok) {
        st.records = st.records.map(function (x) { return x.key === r.key ? Object.assign({}, x, { place: res.place }) : x; });
        render();
        if (st.detail === r.key) showDetail(r.key);
      } else { render(); alertLine((res && (res.message || res.error)) || "The move failed."); }
      return res;
    });
  }
  function childOf(sub) {
    return st.childCache[sub.key] || st.records.filter(function (r) { return r.key === sub.key; })[0] || Object.assign({ priority: "", assignee: "", updated: "", subtasks: [] }, sub);
  }
  function toggleSubtasks(rec, open) {
    var want = open === undefined ? !st.expanded[rec.key] : open;
    if (!!st.expanded[rec.key] === want) return;
    if (want) st.expanded[rec.key] = true; else delete st.expanded[rec.key];
    var keys = (rec.subtasks || []).map(function (x) { return x.key; }).filter(function (k) { return !st.childCache[k]; });
    var focusKey = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute("data-key") : "";
    var refocus = function () {
      var n = focusKey && document.querySelector('.item:not(.child)[data-key="' + focusKey + '"]');
      if (n) n.focus();
    };
    render(); refocus();
    if (want && keys.length && typeof api.children === "function") {
      api.children(keys.slice(0, 50)).then(function (res) {
        if (!res || !res.ok) return;
        res.records.forEach(function (c) { st.childCache[c.key] = c; });
        var active = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute("data-key") : "";
        render();
        var n = active && document.querySelector('.item[data-key="' + active + '"]');
        if (n) n.focus();
      });
    }
  }
  function doneLast(list) {
    return list.filter(function (x) { return x.category !== "done"; }).concat(list.filter(function (x) { return x.category === "done"; }));
  }
  function childRows(parent) {
    var box = el("div", "subrows");
    box.id = "sub-" + parent.key;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Subtasks of " + parent.key);
    doneLast(parent.subtasks.map(childOf)).forEach(function (rec) {
      var r = box.appendChild(el("div", "item child" + (rec.category === "done" ? " dim" : "") + (rec.key === st.detail ? " sel" : "")));
      r.setAttribute("data-key", rec.key);
      r.setAttribute("role", "button");
      r.tabIndex = 0;
      r.appendChild(svg(glyphFor(rec.type)));
      r.appendChild(el("span", "ckey", rec.key));
      r.appendChild(el("span", "sum", rec.summary));
      r.appendChild(statusButton(rec));
      var more = button("", function (b) { openActions(rec, b); }, "icon more");
      more.appendChild(svg("M4 8h.01M8 8h.01M12 8h.01", "2.2"));
      more.setAttribute("aria-label", "Actions for " + rec.key);
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      r.appendChild(more);
      r.addEventListener("click", function () { showDetail(rec.key); });
      r.addEventListener("keydown", function (ev) {
        if (ev.target !== r) return;
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showDetail(rec.key); }
        else if (ev.key === "ArrowLeft") { ev.preventDefault(); var p = document.querySelector('.item:not(.child)[data-key="' + parent.key + '"]'); if (p) p.focus(); }
        else rowNav(ev, r);
      });
    });
    return box;
  }
  function rowNav(ev, r) {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    var all = Array.prototype.slice.call(document.querySelectorAll(".item")), i = all.indexOf(r);
    var next = all[ev.key === "ArrowDown" ? i + 1 : i - 1];
    if (next) next.focus();
  }
  function row(rec) {
    var r = el("div", "item" + (rec.key === st.detail ? " sel" : ""));
    r.setAttribute("data-key", rec.key);
    r.setAttribute("role", "button");
    r.tabIndex = 0;
    var subs = (rec.subtasks || []).length;
    var tile = el("span", "tile");
    tile.appendChild(svg(glyphFor(rec.type)));
    tile.title = rec.type || "";
    r.appendChild(tile);
    var text = el("div", "text");
    var l1 = el("div", "line1");
    l1.appendChild(el("span", "sum", rec.summary));
    l1.appendChild(statusButton(rec));
    text.appendChild(l1);
    var l2 = text.appendChild(el("div", "line2", [rec.key, rec.type].filter(Boolean).join(" · ")));
    if (rec.priority) {
      l2.appendChild(document.createTextNode(" · "));
      var pi = l2.appendChild(el("span", "prio-icon"));
      pi.setAttribute("role", "img");
      pi.setAttribute("aria-label", "Priority: " + rec.priority);
      pi.title = "Priority: " + rec.priority;
      pi.appendChild(priorityGlyph(rec.priority));
    }
    if (st.source !== "assigned") l2.appendChild(document.createTextNode(" · " + (rec.assignee || "Unassigned")));
    if (subs) {
      var doneSubs = rec.subtasks.filter(function (x) { return x.category === "done"; }).length;
      l2.appendChild(el("span", "subcount", subs + " subtask" + (subs === 1 ? "" : "s") + " · " + doneSubs + " done"));
    }
    r.appendChild(text);
    if (subs) {
      var open = !!st.expanded[rec.key];
      var chev = button("", function () { toggleSubtasks(rec); }, "icon chev");
      chev.appendChild(svg("M6 3.5L10.5 8 6 12.5", "1.6"));
      chev.setAttribute("aria-expanded", String(open));
      chev.setAttribute("aria-controls", "sub-" + rec.key);
      chev.setAttribute("aria-label", (open ? "Hide " : "Show ") + subs + " subtask" + (subs === 1 ? "" : "s") + " of " + rec.key);
      r.appendChild(chev);
    }
    r.appendChild(dateText(rec.updated, "when"));
    var send = button("", function (b) { sendToAgent(rec, b); }, "send icon");
    send.appendChild(svg(SEND_GLYPH, "1.2"));
    send.setAttribute("aria-label", "Send " + rec.key + " to agent");
    send.title = "Send to agent";
    r.appendChild(send);
    var more = button("", function (b) { openActions(rec, b); }, "icon more");
    more.appendChild(svg("M4 8h.01M8 8h.01M12 8h.01", "2.2"));
    more.setAttribute("aria-label", "Actions for " + rec.key);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    r.appendChild(more);
    r.addEventListener("click", function () { showDetail(rec.key); });
    r.addEventListener("keydown", function (ev) {
      if (ev.target !== r) return;
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showDetail(rec.key); }
      else if (subs && (ev.key === "ArrowRight" || ev.key === "ArrowLeft")) { ev.preventDefault(); toggleSubtasks(rec, ev.key === "ArrowRight"); }
      else rowNav(ev, r);
    });
    return r;
  }
  function statusButton(rec) {
    var b = button(st.pending[rec.key] ? "pending..." : rec.status, function (btn) { openMenu(rec, btn); }, "pill status");
    b.setAttribute("data-cat", rec.category);
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.disabled = !!st.pending[rec.key];
    return b;
  }
  function replace(rec) {
    st.records = st.records.map(function (r) { return r.key === rec.key ? rec : r; });
    render();
    if (st.detail === rec.key) showDetail(rec.key);
  }
  function runTransition(rec, id) {
    st.pending[rec.key] = true;
    render();
    return api.transition(rec.key, id).then(function (res) {
      delete st.pending[rec.key];
      if (res && res.ok) replace(res.record);
      else { render(); alertLine((res && (res.message || res.error)) || "The transition failed."); }
      return res;
    });
  }
  function alertLine(text, fine) {
    var box = $("results").querySelector(".col") || resultsCol();
    var n = el("div", fine ? "notice" : "error", text);
    box.insertBefore(n, box.firstChild);
    setTimeout(function () { n.remove(); }, 6000);
  }
  function transitionsInto(m, rec, back) {
    fillMenu(m, [{ note: "Loading transitions..." }], "menuitem");
    api.transitions(rec.key).then(function (res) {
      if (menu !== m) return;
      var entries = back ? [{ label: "‹ Back", fn: back }] : [];
      if (!res || !res.ok) entries.push({ note: (res && (res.message || res.error)) || "Could not load transitions." });
      else if (!res.transitions.length) entries.push({ note: "No transitions available." });
      else res.transitions.forEach(function (t) {
        entries.push({ label: t.name + (t.toStatus && t.toStatus !== t.name ? " → " + t.toStatus : ""), fn: function () { closeMenu(); runTransition(rec, t.id); },
          disabled: !!t.needsFields, title: "Needs fields — open in Jira", hint: t.needsFields ? "Needs fields — open in Jira" : "" });
      });
      fillMenu(m, entries, "menuitem");
    });
  }
  function openMenu(rec, anchor) {
    if (menu && menuOwner === anchor) { closeMenu(); return; }
    transitionsInto(popMenu(anchor, "menu"), rec, null);
  }
  function openActions(rec, anchor) {
    if (menu && menuOwner === anchor) { closeMenu(); return; }
    var m = popMenu(anchor, "menu");
    function top() {
      fillMenu(m, [
        { label: "Open in Jira", fn: function () { closeMenu(); api.openIssue(rec.key); } },
        { label: "Send to agent", fn: function () { closeMenu(); sendToAgent(rec, null); } },
        { label: "Change status ›", fn: function () { transitionsInto(m, rec, top); } }
      ].concat((function () {
        var mv = moveEntry(rec);
        return mv ? [{ label: mv.label, disabled: mv.disabled, title: mv.title, hint: mv.disabled ? mv.title : "", fn: function () { closeMenu(); runMove(mv.rec, mv.to); } }] : [];
      })()), "menuitem");
    }
    top();
  }

  function dropBlobs() {
    st.blobs.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    st.blobs = [];
  }
  function sizeText(n) {
    if (!(n > 0)) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    return (Math.round(n / 104857.6) / 10) + " MB";
  }
  function inlineKind(meta) {
    var k = INLINE[String(meta.mimeType || "").toLowerCase()];
    return k && meta.size <= INLINE_MAX[k] ? k : "";
  }
  function blobInto(node, key, meta, thumb, fail) {
    api.attachment(key, meta.id, thumb).then(function (r) {
      if (st.detail !== key || !node.isConnected) return;
      if (!r || !r.ok || !r.bytes) { fail(r); return; }
      var url = URL.createObjectURL(new Blob([r.bytes], { type: r.mime }));
      st.blobs.push(url);
      node.src = url;
      node.classList.remove("loading");
    }, function () { fail(null); });
  }
  function fileChip(key, meta, viewer) {
    var b = button("", function (btn) { if (viewer) openLightbox(btn); else fileMenu(key, meta, btn); }, "file");
    if (viewer) {
      b.classList.add("lb-item");
      b.__cdbMeta = meta; b.__cdbKey = key;
      b.setAttribute("aria-label", "Open " + meta.filename);
    } else {
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
    }
    b.setAttribute("data-attachment", meta.id);
    var icon = b.appendChild(el("span", "ficon"));
    var glyph = function () { return svg("M4.5 2.5h5l3 3v8h-8zM9.5 2.5v3h3", "1.3"); };
    if (meta.thumbnail && INLINE[String(meta.mimeType || "").toLowerCase()] === "image") {
      var t = icon.appendChild(el("img"));
      t.alt = "";
      blobInto(t, key, meta, true, function () { if (t.parentNode) t.parentNode.replaceChild(glyph(), t); });
    } else icon.appendChild(glyph());
    b.appendChild(el("span", "fname", meta.filename));
    b.appendChild(el("span", "fsize", sizeText(meta.size)));
    b.title = meta.filename;
    if (!viewer) return b;
    var wrap = el("span", "filewrap");
    wrap.appendChild(b);
    var more = button("", function (btn) { fileMenu(key, meta, btn); }, "icon more");
    more.appendChild(svg("M4 8h.01M8 8h.01M12 8h.01", "2.2"));
    more.setAttribute("aria-label", "Actions for " + meta.filename);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    wrap.appendChild(more);
    return wrap;
  }
  function fileMenu(key, meta, anchor) {
    if (menu && menuOwner === anchor) { closeMenu(); return; }
    var m = popMenu(anchor, "menu");
    fillMenu(m, [
      { label: "Save to Downloads", fn: function () {
        closeMenu();
        api.download(key, meta.id).then(function (r) { alertLine(r && r.ok ? "Saved to Downloads as " + r.name + "." : (r && (r.message || r.error)) || "Could not save the file.", r && r.ok); });
      } },
      { label: "Open in Jira", fn: function () { closeMenu(); api.openIssue(key); } }
    ], "menuitem");
  }
  function mediaNode(key, meta) {
    var kind = inlineKind(meta);
    if (!kind) return fileChip(key, meta);
    var n = el(kind === "image" ? "img" : "video", kind === "image" ? "media-img loading" : "media-video");
    if (kind === "image") { n.alt = meta.filename; } else { n.controls = true; n.preload = "metadata"; }
    n.classList.add("lb-item");
    n.__cdbMeta = meta; n.__cdbKey = key;
    n.tabIndex = 0;
    n.setAttribute("role", "button");
    n.setAttribute("aria-label", "Open " + meta.filename);
    n.addEventListener("click", function (ev) { ev.preventDefault(); openLightbox(n); });
    n.addEventListener("keydown", function (ev) { if (ev.target === n && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); openLightbox(n); } });
    blobInto(n, key, meta, false, function () { if (n.parentNode) n.parentNode.replaceChild(fileChip(key, meta), n); });
    return n;
  }
  function mediaHook(rec, map) {
    var byId = {};
    (rec.attachments || []).forEach(function (a) { byId[a.id] = a; });
    return { media: function (attrs) { var id = map && typeof attrs.id === "string" ? map[attrs.id] : ""; return id && byId[id] ? mediaNode(rec.key, byId[id]) : null; } };
  }
  function subtasksSection(rec) {
    var sec = el("section", "subtasks");
    sec.setAttribute("aria-label", "Subtasks");
    var h = sec.appendChild(el("h3", "sec-head", "Subtasks"));
    h.appendChild(el("span", "count", String(rec.subtasks.length)));
    doneLast(rec.subtasks).forEach(function (x) {
      var b = button("", function () { showDetail(x.key); }, "subtask" + (x.category === "done" ? " dim" : ""));
      b.setAttribute("data-key", x.key);
      b.appendChild(svg(glyphFor(x.type)));
      b.appendChild(el("span", "ckey", x.key));
      b.appendChild(el("span", "sum", x.summary));
      var pill = b.appendChild(el("span", "pill", x.status));
      pill.setAttribute("data-cat", x.category);
      sec.appendChild(b);
    });
    return sec;
  }
  function attachmentsSection(rec) {
    var list = rec.attachments || [];
    if (!list.length) return null;
    var sec = el("section", "attachments");
    sec.setAttribute("aria-label", "Attachments");
    var h = sec.appendChild(el("h3", "sec-head", "Attachments"));
    h.appendChild(el("span", "count", String(list.length)));
    var box = sec.appendChild(el("div", "files"));
    list.forEach(function (a) { box.appendChild(fileChip(rec.key, a, !!inlineKind(a))); });
    return sec;
  }
  var lb = null;
  var LB_MIN = 0.25, LB_MAX = 8, LB_STEP = 1.25;
  function lbItems(node) {
    var root = node.closest(".cmt-body, .attachments, .adf") || node.parentNode;
    return Array.prototype.slice.call(root.querySelectorAll(".lb-item")).filter(function (n) { return n.closest(".cmt-body, .attachments, .adf") === root; });
  }
  function openLightbox(node) {
    if (lb) lbClose(false);
    var items = lbItems(node);
    if (!items.length) return;
    if (node.tagName === "VIDEO") { try { node.pause(); } catch (e) {} }
    var o = el("div", "lb");
    o.id = "lightbox";
    o.setAttribute("role", "dialog");
    o.setAttribute("aria-modal", "true");
    o.setAttribute("aria-labelledby", "lb-title");
    var bar = o.appendChild(el("div", "lb-bar"));
    var title = bar.appendChild(el("span", "lb-title"));
    title.id = "lb-title";
    var count = bar.appendChild(el("span", "lb-count"));
    count.setAttribute("aria-live", "polite");
    var zoom = bar.appendChild(el("span", "lb-zoom"));
    var note = bar.appendChild(el("span", "lb-note"));
    bar.appendChild(el("span", "grow"));
    function tool(label, path, fn) {
      var b = button("", fn, "icon lb-tool");
      b.setAttribute("aria-label", label);
      b.setAttribute("data-tip", label);
      b.appendChild(svg(path, "1.5"));
      bar.appendChild(b);
      return b;
    }
    function side(label, cls, path, fn) {
      var b = button("", fn, "lb-side " + cls);
      b.setAttribute("aria-label", label);
      b.setAttribute("data-tip", label);
      b.appendChild(svg(path, "1.8"));
      return b;
    }
    tool("Zoom out", "M3.5 8h9", function () { lbZoom(1 / LB_STEP); });
    tool("Zoom in", "M3.5 8h9M8 3.5v9", function () { lbZoom(LB_STEP); });
    tool("Fit or actual size", "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10", function () { lbToggleFit(); });
    tool("Download", "M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10", function () {
      var it = lb.items[lb.i];
      api.download(it.__cdbKey, it.__cdbMeta.id).then(function (r) { note.textContent = r && r.ok ? "Saved to Downloads as " + r.name + "." : (r && (r.message || r.error)) || "Could not save the file."; });
    });
    tool("Open in Jira", "M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5", function () { api.openIssue(lb.items[lb.i].__cdbKey); });
    tool("Close", "M4 4l8 8M12 4l-8 8", function () { lbClose(true); });
    var stage = o.appendChild(el("div", "lb-stage"));
    stage.addEventListener("wheel", function (e) {
      if (!lb || !lb.img) return;
      e.preventDefault();
      var r = stage.getBoundingClientRect();
      lbZoom(e.deltaY < 0 ? LB_STEP : 1 / LB_STEP, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    stage.addEventListener("click", function (e) { if (e.target === stage && lb && !lb.panned) lbClose(true); });
    stage.addEventListener("dblclick", function (e) {
      if (!lb || !lb.img) return;
      var r = stage.getBoundingClientRect();
      lbToggleFit(e.clientX - r.left, e.clientY - r.top);
    });
    stage.addEventListener("pointerdown", lbPanStart);
    var prev = o.appendChild(side("Previous", "lb-prev", "M10 3.5L5.5 8l4.5 4.5", function () { lbGo(-1); }));
    var next = o.appendChild(side("Next", "lb-next", "M6 3.5L10.5 8 6 12.5", function () { lbGo(1); }));
    document.body.appendChild(o);
    lb = { o: o, stage: stage, title: title, count: count, zoom: zoom, note: note, prev: prev, next: next, items: items, i: Math.max(0, items.indexOf(node)), opener: node, s: 1, fit: 1, tx: 0, ty: 0, img: null, panned: false };
    prev.hidden = next.hidden = items.length < 2;
    lbShow();
    var first = o.querySelector('[aria-label="Close"]');
    if (first) first.focus();
  }
  function lbShow() {
    var it = lb.items[lb.i], meta = it.__cdbMeta, kind = inlineKind(meta);
    clear(lb.stage);
    lb.img = null;
    lb.note.textContent = "";
    lb.title.textContent = meta.filename + (meta.size ? " · " + sizeText(meta.size) : "");
    lb.count.textContent = (lb.i + 1) + " of " + lb.items.length;
    var src = it.tagName === "IMG" || it.tagName === "VIDEO" ? it.getAttribute("src") : "";
    var media = el(kind === "video" ? "video" : "img", kind === "video" ? "lb-video" : "lb-img");
    if (kind === "video") { media.controls = true; media.autoplay = true; media.muted = false; }
    else { media.alt = meta.filename; media.draggable = false; lb.img = media; media.addEventListener("load", function () { if (lb && lb.img === media) lbFit(); }); }
    lb.stage.appendChild(media);
    var place = function (url) { media.setAttribute("src", url); if (lb.img === media) lbFit(); };
    if (src) place(src);
    else {
      var spin = lb.stage.appendChild(el("div", "lb-msg", "Loading..."));
      var key = it.__cdbKey, at = lb.i;
      api.attachment(key, meta.id, false).then(function (r) {
        if (!lb || lb.i !== at || st.detail !== key) return;
        spin.remove();
        if (!r || !r.ok || !r.bytes) { media.remove(); lb.stage.appendChild(el("div", "lb-msg", "Cannot show this file: " + ((r && (r.message || r.error)) || "it could not be read."))); return; }
        var url = URL.createObjectURL(new Blob([r.bytes], { type: r.mime }));
        st.blobs.push(url);
        place(url);
      }, function () { if (lb && lb.i === at) { spin.textContent = "Cannot show this file."; } });
    }
    lbFit();
  }
  function lbApply() {
    if (!lb) return;
    lb.stage.setAttribute("data-scale", String(Math.round(lb.s * 1000) / 1000));
    lb.zoom.textContent = Math.round(lb.s * 100) + "%";
    lb.zoom.hidden = !lb.img;
    if (lb.img) lb.img.style.transform = "translate(" + lb.tx + "px, " + lb.ty + "px) scale(" + lb.s + ")";
    lb.stage.classList.toggle("zoomed", !!lb.img && lb.s > lb.fit + 0.001);
  }
  function lbFit() {
    if (!lb) return;
    var W = lb.stage.clientWidth, H = lb.stage.clientHeight, img = lb.img;
    var nw = img ? img.naturalWidth : 0, nh = img ? img.naturalHeight : 0;
    lb.fit = nw && nh && W && H ? Math.min(W / nw, H / nh, 1) : 1;
    lb.s = lb.fit;
    lb.tx = nw && W ? (W - nw * lb.s) / 2 : 0;
    lb.ty = nh && H ? (H - nh * lb.s) / 2 : 0;
    lbApply();
  }
  function lbZoom(f, px, py) {
    if (!lb || !lb.img) return;
    var min = Math.min(LB_MIN, lb.fit), ns = Math.max(min, Math.min(LB_MAX, lb.s * f));
    if (px === undefined) { px = lb.stage.clientWidth / 2; py = lb.stage.clientHeight / 2; }
    lb.tx = px - (px - lb.tx) * ns / lb.s;
    lb.ty = py - (py - lb.ty) * ns / lb.s;
    lb.s = ns;
    lbApply();
  }
  function lbToggleFit(px, py) {
    if (!lb || !lb.img) return;
    if (Math.abs(lb.s - lb.fit) > 0.001) lbFit(); else lbZoom(1 / lb.s, px, py);
  }
  function lbGo(d) {
    if (!lb || lb.items.length < 2) return;
    lb.i = (lb.i + d + lb.items.length) % lb.items.length;
    lbShow();
  }
  function lbPanStart(e) {
    if (!lb || !lb.img || e.target !== lb.img || lb.s <= lb.fit + 0.001 || e.button !== 0) return;
    var x0 = e.clientX, y0 = e.clientY, tx0 = lb.tx, ty0 = lb.ty;
    lb.panned = false;
    function mv(ev) { if (!lb) return; if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 3) lb.panned = true; lb.tx = tx0 + ev.clientX - x0; lb.ty = ty0 + ev.clientY - y0; lbApply(); }
    function up() { window.removeEventListener("pointermove", mv, true); window.removeEventListener("pointerup", up, true); setTimeout(function () { if (lb) lb.panned = false; }, 0); }
    window.addEventListener("pointermove", mv, true);
    window.addEventListener("pointerup", up, true);
  }
  function lbKeys(e) {
    if (!lb) return;
    var k = e.key, zoomed = !!lb.img && lb.s > lb.fit + 0.001, done = true;
    if (k === "Escape") lbClose(true);
    else if (k === "+" || k === "=") lbZoom(LB_STEP);
    else if (k === "-" || k === "_") lbZoom(1 / LB_STEP);
    else if (k === "0") lbFit();
    else if (k === "ArrowLeft" || k === "ArrowRight") { if (zoomed) { lb.tx += k === "ArrowLeft" ? 40 : -40; lbApply(); } else lbGo(k === "ArrowLeft" ? -1 : 1); }
    else if ((k === "ArrowUp" || k === "ArrowDown") && zoomed) { lb.ty += k === "ArrowUp" ? 40 : -40; lbApply(); }
    else if (k === "Tab") {
      var f = Array.prototype.slice.call(lb.o.querySelectorAll("button:not([disabled]), video"));
      var i = f.indexOf(document.activeElement);
      if (f.length) f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }
  function lbClose(restore) {
    if (!lb) return;
    var opener = lb.opener;
    lb.o.remove();
    lb = null;
    if (restore && opener && opener.isConnected) opener.focus();
  }
  window.__cdbJiraLightboxKey = function (k) {
    if (!lb) return false;
    if (k === "+") lbZoom(LB_STEP); else if (k === "-") lbZoom(1 / LB_STEP); else if (k === "0") lbFit();
    return true;
  };
  document.addEventListener("keydown", lbKeys, true);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") lbClose(false); });
  function closeDetail() {
    lbClose(false);
    dropBlobs();
    st.detail = "";
    $("detail").hidden = true;
    $("main").classList.remove("split");
    render();
  }
  function avatar(name, size) {
    var n = String(name || ""), h = 0;
    for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    var a = el("span", "avatar av" + (h % AVATAR_COLORS) + (size ? " " + size : ""), initials(n));
    a.setAttribute("aria-hidden", "true");
    return a;
  }
  function person(name, empty) {
    var v = el("span", "person");
    if (!name) { v.appendChild(el("span", "muted", empty)); return v; }
    v.appendChild(avatar(name));
    v.appendChild(el("span", "", name));
    return v;
  }
  function priorityGlyph(name) {
    var p = String(name || "").toLowerCase();
    var k = p.indexOf("highest") >= 0 || p.indexOf("blocker") >= 0 || p.indexOf("critical") >= 0 ? "up2" : p.indexOf("high") >= 0 ? "up"
      : p.indexOf("lowest") >= 0 || p.indexOf("trivial") >= 0 ? "down2" : p.indexOf("low") >= 0 || p.indexOf("minor") >= 0 ? "down" : "mid";
    var g = svg(PRIORITY_GLYPHS[k], "1.6");
    g.setAttribute("class", "prio prio-" + k.replace(/2$/, ""));
    return g;
  }
  function detailStatus(rec) {
    var pending = !!st.pending[rec.key];
    var b = button(pending ? "pending..." : rec.status, function (btn) { openMenu(rec, btn); }, "dstatus");
    b.id = "detail-status";
    b.setAttribute("data-cat", rec.category);
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-label", "Status: " + rec.status + ". Change status");
    b.appendChild(svg("M5 6.5l3 3 3-3", "1.5"));
    b.disabled = pending;
    return b;
  }
  function detailsCard(rec) {
    var card = el("section", "dcard");
    var head = button("Details", function () {
      if (detailStacked()) st.detailsOpenStacked = !st.detailsOpenStacked;
      else {
        st.detailsOpen = !st.detailsOpen;
        if (typeof api.setDetailsOpen === "function") api.setDetailsOpen(st.detailsOpen);
      }
      applyDetailsOpen();
    }, "dcard-head");
    head.setAttribute("aria-controls", "detail-fields");
    head.appendChild(svg("M5 6.5l3 3 3-3", "1.5"));
    card.appendChild(head);
    var body = el("dl", "fields");
    body.id = "detail-fields";
    function field(label, value) {
      body.appendChild(el("dt", "", label));
      var dd = el("dd");
      if (typeof value === "string") dd.appendChild(value ? el("span", "", value) : el("span", "muted", "None"));
      else dd.appendChild(value);
      body.appendChild(dd);
    }
    if (rec.type) {
      var type = el("span", "person");
      type.appendChild(svg(glyphFor(rec.type)));
      type.appendChild(el("span", "", rec.type));
      field("Type", type);
    }
    if (rec.priority) {
      var pr = el("span", "person");
      pr.appendChild(priorityGlyph(rec.priority));
      pr.appendChild(el("span", "", rec.priority));
      field("Priority", pr);
    }
    field("Assignee", person(rec.assignee, "Unassigned"));
    if (rec.reporter) field("Reporter", person(rec.reporter, ""));
    if ((rec.labels || []).length) {
      var labels = el("span", "chips");
      rec.labels.forEach(function (l) { labels.appendChild(el("span", "chip", l)); });
      field("Labels", labels);
    }
    if ((rec.fixVersions || []).length) field("Fix versions", rec.fixVersions.join(", "));
    if (rec.parent) {
      var link = button(rec.parent.key + (rec.parent.summary ? " " + rec.parent.summary : ""), function () { showDetail(rec.parent.key); }, "linkish plink");
      link.title = "Open " + rec.parent.key;
      field("Parent", link);
    }
    if (rec.due) field("Due date", dateText(rec.due));
    if (rec.created) field("Created", dateText(rec.created));
    if (rec.updated) field("Updated", dateText(rec.updated));
    card.appendChild(body);
    return card;
  }
  function detailStacked() {
    var b = $("detail"), w = b.clientWidth;
    if (!w) return false;
    var cs = getComputedStyle(b);
    return w - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) < STACKED_BELOW;
  }
  function applyDetailsOpen() {
    var head = document.querySelector("#detail .dcard-head"), body = $("detail-fields");
    if (!head || !body) return;
    var open = detailStacked() ? st.detailsOpenStacked : st.detailsOpen;
    head.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
  }
  function wrapTables(root) {
    Array.prototype.slice.call(root.querySelectorAll("table")).forEach(function (t) {
      var w = el("div", "tablewrap");
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    });
    return root;
  }
  function commentsSection(res, rec, hook) {
    var sec = el("section", "comments");
    sec.setAttribute("aria-label", "Comments");
    var total = typeof res.commentsTotal === "number" ? res.commentsTotal : res.comments.length;
    var h = sec.appendChild(el("h3", "sec-head", "Comments"));
    h.appendChild(el("span", "count", String(total)));
    if (!res.comments.length && !res.commentsError) sec.appendChild(el("p", "muted", "No comments yet."));
    res.comments.slice(0, COMMENTS_SHOWN).forEach(function (c) {
      var n = el("article", "cmt");
      n.appendChild(avatar(c.author || "Someone", "lg"));
      var who = el("div", "cmt-who");
      who.appendChild(el("div", "cmt-name", c.author || "Someone"));
      var t = el("div", "muted cmt-time", ago(c.created));
      t.title = fullDate(c.created);
      who.appendChild(t);
      n.appendChild(who);
      var body = wrapTables(adf.render(c.body, document, hook));
      body.classList.add("cmt-body");
      n.appendChild(body);
      sec.appendChild(n);
    });
    if (total > COMMENTS_SHOWN) sec.appendChild(button("View all " + total + " comments in Jira", function () { api.openIssue(rec.key); }, "linkish muted more-comments"));
    if (res.commentsError) sec.appendChild(el("div", "muted", "Comments: " + res.commentsError));
    return sec;
  }
  function showDetail(key) {
    lbClose(false);
    dropBlobs();
    st.detail = key;
    var box = $("detail");
    box.hidden = false;
    $("main").classList.add("split");
    clear(box);
    box.scrollTop = 0;
    box.appendChild(el("div", "muted", "Loading " + key + "..."));
    document.querySelectorAll(".item").forEach(function (n) { n.classList.toggle("sel", n.getAttribute("data-key") === key); });
    api.issue(key).then(function (res) {
      if (st.detail !== key) return;
      if (!res || !res.ok) { problem(box, res, function () { showDetail(key); }); return; }
      clear(box);
      var rec = res.record;
      var top = el("div", "dtop");
      top.appendChild(el("span", "key", rec.key));
      var x = button("", closeDetail, "icon");
      x.appendChild(svg("M4 4l8 8M12 4l-8 8", "1.5"));
      x.setAttribute("aria-label", "Close the ticket and go back to the list");
      top.appendChild(x);
      box.appendChild(top);
      var grid = box.appendChild(el("div", "dgrid"));
      grid.appendChild(el("h2", "dtitle", rec.summary));
      var side = grid.appendChild(el("aside", "dside"));
      var mainCol = grid.appendChild(el("div", "dmain"));
      var hook = mediaHook(rec, res.mediaMap);
      var body = wrapTables(adf.render(res.description, document, hook));
      if (!body.firstChild) body.appendChild(el("p", "muted", "No description."));
      mainCol.appendChild(body);
      if ((rec.subtasks || []).length) mainCol.appendChild(subtasksSection(rec));
      var files = attachmentsSection(rec);
      if (files) mainCol.appendChild(files);
      mainCol.appendChild(commentsSection(res, rec, hook));
      side.setAttribute("aria-label", "Ticket details");
      var acts = side.appendChild(el("div", "dacts"));
      acts.appendChild(detailStatus(rec));
      var send = button("", function (btn) { sendToAgent(rec, btn); }, "primary");
      send.appendChild(svg(SEND_GLYPH, "1.2"));
      send.appendChild(el("span", "lbl", "Send to agent"));
      acts.appendChild(send);
      var open = button("", function () { api.openIssue(rec.key); }, "icon");
      open.setAttribute("aria-label", "Open in Jira");
      open.title = "Open in Jira";
      open.appendChild(svg("M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5", "1.4"));
      acts.appendChild(open);
      var mv = moveEntry(rec);
      if (mv) {
        var mb = button(st.pending[rec.key] ? "pending..." : mv.label, function () { runMove(mv.rec, mv.to); }, "secondary");
        mb.id = "detail-move";
        mb.disabled = !!mv.disabled || !!st.pending[rec.key];
        if (mv.title) mb.title = mv.title;
        acts.appendChild(mb);
      }
      side.appendChild(detailsCard(rec));
      applyDetailsOpen();
    });
  }
  function sendToAgent(rec, btn) {
    var label = btn ? btn.querySelector(".lbl") : null, old = label ? label.textContent : "";
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    if (label) label.textContent = "Starting...";
    api.send(rec.key).then(function (res) {
      if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); }
      if (label) label.textContent = old;
      if (res && !res.ok && !res.cancelled) alertLine(res.error || "Could not start the session.");
    });
  }


  function init() {
    api.state().then(function (s) {
      if (!s || !s.ok) { problem($("results"), s); return; }
      st.queries = s.queries || [];
      st.source = st.lastTab = s.lastPreset || "assigned";
      st.project = s.project || "";
      st.detailsOpen = s.detailsOpen !== false;
      if (SORTS.some(function (x) { return x[0] === s.sort; })) st.sort = s.sort;
      fillSources();
      if (!s.configured) { problem($("results"), { kind: "config", message: "Jira is not set up yet." }); return; }
      load(false);
      api.projects().then(function (p) {
        st.projects = p && p.ok ? p.projects : [];
        if (!projectItems().some(function (i) { return i.value === st.project; })) st.project = "";
        fillTools();
      });
    });
  }

  $("tabs").addEventListener("keydown", function (ev) {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight" && ev.key !== "Home" && ev.key !== "End") return;
    var tabs = Array.prototype.slice.call($("tabs").querySelectorAll('[role="tab"]')), i = tabs.indexOf(document.activeElement);
    if (!tabs.length) return;
    ev.preventDefault();
    var next = ev.key === "Home" ? 0 : ev.key === "End" ? tabs.length - 1 : (i + (ev.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
  });
  function menuKeys(id, open) {
    $(id).addEventListener("click", function (ev) { ev.stopPropagation(); open(); });
    $(id).addEventListener("keydown", function (ev) {
      if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && menuOwner !== $(id)) { ev.preventDefault(); open(); }
    });
  }
  function openProjects() {
    var b = $("filter");
    if (menu && menuOwner === b) { closeMenu(); return; }
    var m = popMenu(b, "listbox");
    var entries = projectItems().map(function (it) {
      return { label: it.label, selected: it.value === st.project, fn: function () { closeMenu(); b.focus(); st.project = it.value; fillTools(); load(false); } };
    });
    Object.keys(st.boards).sort().forEach(function (project) {
      var info = st.boards[project];
      if (!info || !info.all || info.all.length < 2) return;
      entries.push({ sep: true });
      entries.push({ note: project + " board" });
      info.all.forEach(function (bd) {
        entries.push({ label: "Board: " + bd.name, selected: bd.id === info.current.id, fn: function () {
          closeMenu(); b.focus();
          Promise.resolve(api.setBoard(project, bd.id)).then(function () { load(false); });
        } });
      });
    });
    fillMenu(m, entries, "option");
  }
  function openSort() {
    var b = $("sort");
    if (menu && menuOwner === b) { closeMenu(); return; }
    var m = popMenu(b, "listbox");
    fillMenu(m, SORTS.map(function (x) {
      return { label: x[1], selected: x[0] === st.sort, fn: function () { closeMenu(); b.focus(); st.sort = x[0]; st.sortChosen = true; fillTools(); load(false); } };
    }), "option");
  }
  function openQuery() {
    var b = $("query");
    if (menu && menuOwner === b) { closeMenu(); return; }
    var m = popMenu(b, "menu");
    function top() {
      fillMenu(m, [
        { label: "Save current as query", disabled: st.source !== "jql", title: "Run a search or JQL first", fn: saveForm },
        { label: "Free JQL…", fn: function () { closeMenu(); st.jqlMode = true; $("jql").placeholder = "Type JQL and press Enter"; $("jql").focus(); $("jql").select(); } },
        { label: "Manage saved queries", disabled: !st.queries.length, title: "No saved queries yet", fn: manage },
        { sep: true },
        { label: "Refresh", fn: function () { closeMenu(); load(false); } }
      ], "menuitem");
    }
    function saveForm() {
      clear(m);
      var name = el("input");
      name.type = "text"; name.maxLength = 80; name.placeholder = "Name this query"; name.setAttribute("aria-label", "Query name");
      m.appendChild(name);
      var save = button("Save query", go);
      save.setAttribute("role", "menuitem");
      m.appendChild(save);
      function go() {
        var n = name.value.trim();
        if (!n) { name.focus(); return; }
        api.saveQuery(n, st.jql).then(function (res) {
          if (!res || !res.ok) { closeMenu(); alertLine((res && res.error) || "Could not save the query."); return; }
          closeMenu(); st.queries = res.queries; st.jqlMode = false; $("jql").value = ""; selectTab("q:" + n);
        });
      }
      name.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); go(); }
        else if (ev.key === " ") ev.stopPropagation();
      });
      name.focus();
    }
    function manage() {
      clear(m);
      var back = button("‹ Back", top);
      back.setAttribute("role", "menuitem");
      m.appendChild(back);
      st.queries.forEach(function (q) {
        var line = m.appendChild(el("div", "line"));
        line.appendChild(el("span", "", q.name));
        var del = button("Delete", function () {
          if (del.getAttribute("data-armed") !== "1") { del.setAttribute("data-armed", "1"); del.textContent = "Confirm delete"; del.className = "danger"; return; }
          api.deleteQuery(q.name).then(function (res) {
            if (!res || !res.ok) { alertLine((res && res.error) || "Could not delete the query."); return; }
            st.queries = res.queries;
            if (st.source === "q:" + q.name) selectTab("assigned"); else fillSources();
            if (st.queries.length) manage(); else top();
          });
        });
        del.setAttribute("role", "menuitem");
        del.setAttribute("aria-label", "Delete " + q.name);
        line.appendChild(del);
      });
      back.focus();
    }
    top();
  }
  menuKeys("filter", openProjects);
  menuKeys("sort", openSort);
  menuKeys("query", openQuery);
  $("jql").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); runSearch(); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); $("jql").value = ""; st.jqlMode = false; $("jql").placeholder = "Search or JQL"; if (st.source === "jql") selectTab(st.lastTab); }
  });
  $("view-list").addEventListener("click", function () { setView("list"); });
  $("view-board").addEventListener("click", function () { setView("board"); });
  function setView(v) {
    st.view = v;
    $("view-list").setAttribute("aria-selected", String(v === "list"));
    $("view-board").setAttribute("aria-selected", String(v === "board"));
    render();
  }
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a") : null;
    if (a) { ev.preventDefault(); var href = a.getAttribute("href"); if (href) api.openExternal(href); return; }
    if (menu && !menu.contains(ev.target) && !(menuOwner && menuOwner.contains(ev.target))) closeMenu();
  }, true);
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeMenu(); });
  function syncGutter() {
    var r = $("results");
    $("head").style.setProperty("--sbw", Math.max(0, r.offsetWidth - r.clientWidth) + "px");
  }
  window.addEventListener("resize", syncGutter);
  window.addEventListener("resize", applyDetailsOpen);
  if (typeof ResizeObserver === "function") new ResizeObserver(applyDetailsOpen).observe($("detail"));
  if (typeof ResizeObserver === "function") new ResizeObserver(syncGutter).observe($("results"));
  syncGutter();
  $("results").addEventListener("scroll", function () { $("head").classList.toggle("scrolled", $("results").scrollTop > 0); });
  window.addEventListener("focus", function () {
    var a = document.activeElement;
    if (!a || a === document.body) $("jql").focus();
    if (st.loadedAt && Date.now() - st.loadedAt > STALE_MS) load(false);
  });
  function setCover(full) { $("close").hidden = full !== true; }
  $("close").addEventListener("click", function () { api.hide(); });
  if (typeof api.onCover === "function") api.onCover(setCover);
  if (typeof api.cover === "function") api.cover().then(function (r) { if (r && r.ok) setCover(r.full); }, function () {});
  if (typeof api.onTheme === "function") api.onTheme(applyTheme);
  if (typeof api.theme === "function") api.theme().then(function (r) { if (r && r.ok) applyTheme(r.theme); }, function () {});
  $("jql").focus();
  init();
})();
