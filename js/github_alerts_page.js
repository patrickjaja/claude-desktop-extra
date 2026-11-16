/*
 * github_alerts_page.js - GitHub alert blockquotes as coloured callouts, in
 * claude.ai / claude.com and 3P app://localhost chats. Embedded by
 * js/github_alerts_main.js (which patches/community/add_feature_github_alerts.nim
 * injects into the bundle).
 *
 * The renderer leaves a blockquote that opens with `[!NOTE]` (or TIP /
 * IMPORTANT / WARNING / CAUTION) as literal text. Adjacent quoted blocks may
 * also be merged into ONE <blockquote> whose <p> children each start with a
 * marker line, so the unit of work is a child run: every <p> whose leading
 * plain text opens with a marker starts a callout, and the following siblings
 * up to the next marker belong to it.
 *
 * Only text values are changed and classes are added, plus one small title row
 * (an inline SVG icon and the label) when icons are on. Inline SVG is used
 * because the page CSP blocks data: images but not DOM nodes. Editable
 * surfaces (ProseMirror, contenteditable, textarea), Extra settings, document
 * prose and upstream-handled alert/reply blocks are skipped. Every stripped
 * marker is remembered in data-cdb-alert-type and data-cdb-alert-raw (with the
 * touched Text node tracked in a WeakMap) so later passes rebuild or clear
 * state accurately on React re-renders/reuse and live teardown restores the
 * literal marker text in place.
 *
 * The main half calls this file once per document with
 *   var __CDB_GH_ALERTS_OPTS = {"enabled":true,"icons":true};
 * prepended. A later call with enabled:false tears everything back down, which
 * is how the Settings switch applies without a reload.
 *
 * ES5 only, ASCII only. It runs through webContents.executeJavaScript in a page.
 */
;(function () {
  "use strict";
  if (typeof window === "undefined" || !window.document) return;

  if (window.__cdbGhAlerts && window.__cdbGhAlerts.version === 1) {
    try { window.__cdbGhAlerts.apply(__CDB_GH_ALERTS_OPTS); } catch (e) {}
    return;
  }

  var TYPES = {
    NOTE: { cls: "cdb-alert-note", label: "Note", icon: "note" },
    TIP: { cls: "cdb-alert-tip", label: "Tip", icon: "tip" },
    IMPORTANT: { cls: "cdb-alert-important", label: "Important", icon: "important" },
    WARNING: { cls: "cdb-alert-warning", label: "Warning", icon: "warning" },
    CAUTION: { cls: "cdb-alert-caution", label: "Caution", icon: "caution" }
  };
  var MARKER = /^[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\r?\n|[ \t]+|[ \t]*$)/i;
  var SKIP_ANCESTORS = '[contenteditable="true"], [contenteditable=""], .ProseMirror, textarea, .cdbx-root, .epitaxy-document-prose';
  var HOST_CLS = "cdb-alert-host";
  var SEG_OWN = [
    "cdb-alert-seg", "cdb-alert-head", "cdb-alert-head-empty",
    "cdb-alert-first", "cdb-alert-last", "cdb-alert-only", "cdb-alert-titled",
    "cdb-alert-note", "cdb-alert-tip", "cdb-alert-important",
    "cdb-alert-warning", "cdb-alert-caution"
  ];
  var SVGNS = "http://www.w3.org/2000/svg";

  // 16x16 line icons, stroke based, one path set per type. A "dot" part is a
  // filled circle whose y is read back from the "M8 <y>h.01" form.
  var ICON_PATHS = {
    note: [
      { d: "M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9Z" },
      { d: "M8 7.2v4" },
      { d: "M8 4.9h.01", dot: true }
    ],
    tip: [
      { d: "M8 1.8a3.7 3.7 0 0 0-2.2 6.6c.5.4.8 1 .8 1.6v.4h2.8V10c0-.6.3-1.2.8-1.6A3.7 3.7 0 0 0 8 1.8Z" },
      { d: "M6.7 12.6h2.6" },
      { d: "M7.2 14.2h1.6" }
    ],
    important: [
      { d: "M2.9 3.1h10.2v7.4H8.5L5.9 12.9v-2.4H2.9Z" },
      { d: "M8 5.1v2.9" },
      { d: "M8 9.4h.01", dot: true }
    ],
    warning: [
      { d: "M8 2.3 14.1 13H1.9Z" },
      { d: "M8 6.1v3.2" },
      { d: "M8 11.1h.01", dot: true }
    ],
    caution: [
      { d: "M5.3 1.9h5.4l3.4 3.4v5.4l-3.4 3.4H5.3L1.9 10.7V5.3Z" },
      { d: "M8 4.7v3.6" },
      { d: "M8 10.6h.01", dot: true }
    ]
  };

  var ENABLED = true;
  var ICONS = true;
  var pending = false;
  var queue = [];
  var strippedNodes = typeof WeakMap === "function" ? new WeakMap() : null;

  function log(msg) {
    try { if (window.console && console.log) console.log("[cdb-gh-alerts] " + msg); } catch (e) {}
  }

  function tagOf(el) {
    return el && el.tagName ? String(el.tagName).toLowerCase() : "";
  }

  function isTitle(n) {
    return !!(n && n.nodeType === 1 && n.classList && n.classList.contains("cdb-alert-title"));
  }

  function shouldSkip(bq) {
    if (!bq || bq.nodeType !== 1 || tagOf(bq) !== "blockquote") return true;
    if (bq.isContentEditable) return true;
    if (bq.hasAttribute && (bq.hasAttribute("data-alert") || bq.hasAttribute("data-reply-quote-block"))) return true;
    if (bq.closest && bq.closest(SKIP_ANCESTORS + ", blockquote[data-alert], [data-reply-quote-block]")) return true;
    return false;
  }

  function dotY(d) {
    var m = /^M8 ([0-9.]+)h/.exec(d);
    return m ? m[1] : "8";
  }

  function leadingRun(head) {
    var kids = head.childNodes, nodes = [], parts = [], afterEl = null, i, n;
    for (i = 0; i < kids.length; i++) {
      n = kids[i];
      if (isTitle(n)) continue;
      if (n.nodeType === 3) {
        nodes.push(n);
        parts.push(n.nodeValue || "");
      } else if (n.nodeType === 1) {
        afterEl = n;
        break;
      }
    }
    return { nodes: nodes, text: parts.join(""), afterEl: afterEl };
  }

  function stripRun(nodes, len) {
    var left = len, i, node, t;
    for (i = 0; i < nodes.length && left > 0; i++) {
      node = nodes[i];
      t = node.nodeValue || "";
      if (t.length <= left) {
        left -= t.length;
        node.nodeValue = "";
      } else {
        node.nodeValue = t.slice(left);
        left = 0;
      }
      if (strippedNodes) strippedNodes.set(node, node.nodeValue);
    }
  }

  function runMatchesStripped(nodes) {
    if (!strippedNodes) return true;
    if (!nodes.length || !strippedNodes.has(nodes[0])) return false;
    for (var i = 0; i < nodes.length; i++) {
      if (strippedNodes.has(nodes[i]) && strippedNodes.get(nodes[i]) !== nodes[i].nodeValue) {
        return false;
      }
    }
    return true;
  }

  function dropSegOwn(el) {
    if (!el || !el.classList) return;
    for (var i = 0; i < SEG_OWN.length; i++) el.classList.remove(SEG_OWN[i]);
  }

  function clearLeadBr(el) {
    var kids = el && el.children, i;
    if (!kids) return;
    for (i = 0; i < kids.length; i++) {
      if (tagOf(kids[i]) === "br" && kids[i].classList) {
        kids[i].classList.remove("cdb-alert-lead-br");
      }
    }
  }

  function reset(bq) {
    var i, kids;
    if (bq && bq.classList) bq.classList.remove(HOST_CLS);
    kids = bq.children;
    for (i = 0; i < kids.length; i++) {
      dropSegOwn(kids[i]);
      clearLeadBr(kids[i]);
    }
  }

  function buildIcon(name) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "cdb-alert-ico");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    var parts = ICON_PATHS[name] || [], i, el, p;
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      el = document.createElementNS(SVGNS, p.dot ? "circle" : "path");
      if (p.dot) {
        el.setAttribute("cx", "8");
        el.setAttribute("cy", dotY(p.d));
        el.setAttribute("r", "0.85");
        el.setAttribute("fill", "currentColor");
      } else {
        el.setAttribute("d", p.d);
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", "currentColor");
        el.setAttribute("stroke-width", "1.4");
        el.setAttribute("stroke-linecap", "round");
        el.setAttribute("stroke-linejoin", "round");
      }
      svg.appendChild(el);
    }
    return svg;
  }

  function titleRow(head) {
    var kids = head.children, i;
    for (i = 0; i < kids.length; i++) {
      if (isTitle(kids[i])) return kids[i];
    }
    return null;
  }

  function dropTitle(head) {
    var row = titleRow(head);
    if (row && row.parentNode) row.parentNode.removeChild(row);
    if (head && head.classList) head.classList.remove("cdb-alert-titled");
  }

  function ensureTitle(head, type) {
    var row = titleRow(head);
    if (row && row.getAttribute("data-cdb-icon") !== type.icon) {
      dropTitle(head);
      row = null;
    }
    if (!row) {
      row = document.createElement("span");
      row.className = "cdb-alert-title";
      row.setAttribute("contenteditable", "false");
      row.setAttribute("data-cdb-icon", type.icon);
      var name = document.createElement("span");
      name.className = "cdb-alert-name";
      name.textContent = type.label;
      row.appendChild(buildIcon(type.icon));
      row.appendChild(name);
      head.insertBefore(row, head.firstChild);
    }
    head.classList.add("cdb-alert-titled");
  }

  function syncHeadBody(head) {
    clearLeadBr(head);
    var kids = head.childNodes, i, n, leadBr = null, sawBody = false;
    for (i = 0; i < kids.length; i++) {
      n = kids[i];
      if (isTitle(n)) continue;
      if (n.nodeType === 3) {
        if ((n.nodeValue || "").trim().length > 0) sawBody = true;
      } else if (n.nodeType === 1) {
        if (!leadBr && tagOf(n) === "br") {
          leadBr = n;
          if (n.classList) n.classList.add("cdb-alert-lead-br");
        } else {
          sawBody = true;
        }
      }
      if (sawBody) break;
    }
    if (head.classList) {
      if (!sawBody) head.classList.add("cdb-alert-head-empty");
      else head.classList.remove("cdb-alert-head-empty");
    }
  }

  function typeOf(el) {
    if (tagOf(el) !== "p") return null;
    var run = leadingRun(el);
    var m = run.text ? MARKER.exec(run.text) : null;
    if (m && (!run.afterEl || tagOf(run.afterEl) === "br" || /\s$/.test(m[0]))) {
      var t = TYPES[m[1].toUpperCase()];
      if (!t) return null;
      stripRun(run.nodes, m[0].length);
      if (el.setAttribute) {
        el.setAttribute("data-cdb-alert-type", m[1].toLowerCase());
        el.setAttribute("data-cdb-alert-raw", m[0]);
      }
      return t;
    }
    var a = el.getAttribute ? el.getAttribute("data-cdb-alert-type") : null;
    if (!a || !TYPES[String(a).toUpperCase()]) return null;
    if (
      (run.nodes.length > 0 && !runMatchesStripped(run.nodes)) ||
      (run.nodes.length === 0 && (!run.afterEl || tagOf(run.afterEl) !== "br"))
    ) {
      if (el.removeAttribute) {
        el.removeAttribute("data-cdb-alert-type");
        el.removeAttribute("data-cdb-alert-raw");
      }
      dropTitle(el);
      return null;
    }
    return TYPES[String(a).toUpperCase()];
  }

  function upgrade(bq) {
    if (shouldSkip(bq)) return false;
    reset(bq);

    var kids = bq.children, i, el, type;
    var groups = [], cur = null;
    for (i = 0; i < kids.length; i++) {
      el = kids[i];
      if (!el.classList) continue;
      type = typeOf(el);
      if (type) {
        cur = { type: type, segs: [el] };
        groups.push(cur);
      } else if (cur) {
        cur.segs.push(el);
      }
    }
    if (!groups.length) return false;

    bq.classList.add(HOST_CLS);
    for (i = 0; i < groups.length; i++) {
      var g = groups[i], k, s;
      for (k = 0; k < g.segs.length; k++) {
        s = g.segs[k];
        s.classList.add("cdb-alert-seg", g.type.cls);
        if (k === 0) s.classList.add("cdb-alert-head", "cdb-alert-first");
        if (k === g.segs.length - 1) s.classList.add("cdb-alert-last");
        if (g.segs.length === 1) s.classList.add("cdb-alert-only");
      }
      var head = g.segs[0];
      syncHeadBody(head);
      if (ICONS) ensureTitle(head, g.type);
      else dropTitle(head);
    }
    return true;
  }

  function sweep(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var list, i, n = 0;
    try { list = scope.querySelectorAll("blockquote"); } catch (e) { list = []; }
    for (i = 0; i < list.length; i++) if (upgrade(list[i])) n++;
    if (scope === document) { try { obs.takeRecords(); } catch (e) {} }
    return n;
  }

  function push(bq) {
    if (!bq || shouldSkip(bq) || queue.indexOf(bq) > -1) return;
    queue.push(bq);
  }

  function flush() {
    pending = false;
    var batch = queue.slice(0), i, n = 0;
    queue.length = 0;
    if (!ENABLED) return;
    for (i = 0; i < batch.length; i++) {
      if (batch[i].isConnected === false) continue;
      if (upgrade(batch[i])) n++;
    }
    try { obs.takeRecords(); } catch (e) {}
    if (n) log("upgraded " + n + " blockquote(s)");
  }

  function schedule() {
    if (pending) return;
    pending = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(flush);
    else window.setTimeout(flush, 16);
  }

  function noteNode(node, isAdded) {
    if (!node) return;
    var el = node.nodeType === 1 ? node : node.parentNode;
    if (!el || el.nodeType !== 1) return;
    var bq = el.closest ? el.closest("blockquote") : null;
    if (bq) push(bq);
    if (isAdded && node.nodeType === 1 && node.querySelectorAll) {
      var list = node.querySelectorAll("blockquote"), i;
      for (i = 0; i < list.length; i++) push(list[i]);
    }
  }

  var obs = new MutationObserver(function (muts) {
    if (!ENABLED) return;
    var i, j, added;
    for (i = 0; i < muts.length; i++) {
      noteNode(muts[i].target, false);
      added = muts[i].addedNodes;
      if (added) for (j = 0; j < added.length; j++) noteNode(added[j], true);
    }
    if (queue.length) schedule();
  });

  function arm() {
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) {
      log("observer attach error: " + (e && e.message ? e.message : e));
    }
  }

  function teardown() {
    try { obs.disconnect(); } catch (e) {}
    queue.length = 0;
    pending = false;

    var marked, i, el, raw, bq;
    try { marked = document.querySelectorAll("[data-cdb-alert-type]"); } catch (e) { marked = []; }
    for (i = 0; i < marked.length; i++) {
      el = marked[i];
      if (!el || el.nodeType !== 1) continue;
      if (el.isContentEditable) continue;
      if (el.closest && el.closest(SKIP_ANCESTORS)) continue;
      bq = el.closest ? el.closest("blockquote") : null;
      if (bq && shouldSkip(bq)) continue;
      dropTitle(el);
      clearLeadBr(el);
      raw = el.getAttribute ? el.getAttribute("data-cdb-alert-raw") || "" : "";
      if (raw) {
        var run = leadingRun(el), k;
        if (run.nodes.length > 0) {
          if (runMatchesStripped(run.nodes)) {
            run.nodes[0].nodeValue = raw + (run.nodes[0].nodeValue || "");
          }
          if (strippedNodes) {
            for (k = 0; k < run.nodes.length; k++) strippedNodes.delete(run.nodes[k]);
          }
        } else if (run.afterEl && tagOf(run.afterEl) === "br") {
          el.insertBefore(document.createTextNode(raw), run.afterEl);
        } else if (!run.afterEl && !el.firstChild) {
          el.appendChild(document.createTextNode(raw));
        }
      }
      if (el.removeAttribute) {
        el.removeAttribute("data-cdb-alert-type");
        el.removeAttribute("data-cdb-alert-raw");
      }
    }

    var list, kids, j;
    try { list = document.querySelectorAll("blockquote"); } catch (e) { list = []; }
    for (i = 0; i < list.length; i++) {
      if (shouldSkip(list[i])) continue;
      reset(list[i]);
      kids = list[i].children;
      for (j = 0; j < kids.length; j++) dropTitle(kids[j]);
    }
  }

  // Called once at install time and again by the main half on every settings
  // change, so the switch applies without a reload.
  function apply(opts) {
    var o = opts || {};
    ENABLED = o.enabled !== false;
    ICONS = o.icons === true;
    if (!ENABLED) { teardown(); return { ok: true, enabled: false }; }
    arm();
    var n = sweep(document);
    if (n) log("upgraded " + n + " blockquote(s) on load");
    return { ok: true, enabled: true, icons: ICONS, upgraded: n };
  }

  window.__cdbGhAlerts = {
    version: 1,
    apply: apply,
    sweep: function () { return sweep(document); },
    stop: function () { try { obs.disconnect(); } catch (e) {} }
  };

  apply(typeof __CDB_GH_ALERTS_OPTS !== "undefined" ? __CDB_GH_ALERTS_OPTS : null);
})();
