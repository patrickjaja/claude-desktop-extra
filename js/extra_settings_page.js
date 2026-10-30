/*
 * extra_settings_page.js - the "Extra" area inside the claude.ai Settings modal.
 *
 * Injected with webContents.executeJavaScript() on every http(s) dom-ready by
 * patches/add_feature_extra_settings.nim. The IIFE returns a one-line status
 * string, which the main process logs to logs/claude-patches.log.
 *
 * The Settings modal belongs to the REMOTE claude.ai SPA: we do not control its
 * markup and it can change without a desktop release. The shape this file is
 * fitted to is captured verbatim in baseline/SETTINGS_NAV_CAPTURE.md - READ THAT
 * FIRST when refitting. Its load-bearing facts:
 *
 *   - there is NO per-group wrapper. ONE scroll container holds a group HEADER
 *     div and a group <ul> as plain alternating SIBLINGS, and the last group is
 *     a header followed by a bare <a> with no list at all.
 *   - a row is <li><button><span data-cds="Icon"><span label>. The icon is an
 *     Anthropicons ICON-FONT span whose text is a private-use ligature - not an
 *     <svg>, not an <img>.
 *   - the selected row carries aria-current="page" on the BUTTON, plus a class
 *     swap against its unselected siblings.
 *
 * Four rules follow from that.
 *
 *   1. SEMANTIC ANCHORS ONLY. Never a minified or generated class name. The nav
 *      is located by finding known settings labels ("General", "Account", ...)
 *      inside a [role=dialog] and taking the CONTROL each label sits in; the
 *      insertion point is the group header whose visible text is "Desktop app".
 *      The icon box is found by its data-cds attribute, and the label span by
 *      being the element that is NOT that box.
 *   2. NOTHING IS FABRICATED THAT CAN BE CLONED. Our group header is a clone of
 *      a real header, our list a clone of a real <ul>, our rows clones of a real
 *      row, and the selected look is BORROWED at click time by diffing the real
 *      selected button against its siblings. Font, size, indentation, icon box
 *      and pill all come from upstream classes we never have to name - and they
 *      keep working when upstream restyles them.
 *   3. EVERY FAILURE IS SOFT, AND NEVER PRODUCES INVALID MARKUP. If the dialog
 *      never appears, or the nav cannot be identified, we log at most one line
 *      and do nothing. With no group header to anchor on, our rows are appended
 *      to the last real list behind a divider row - a <li> inside a <ul>, never
 *      a <div>. If the selected-row diff is ambiguous, our own outline marks the
 *      active item rather than a wrong pill. The standalone Ctrl+Shift+T theme
 *      picker window stays the robust fallback.
 *   4. The installer logs one sanitized DOM-shape line (tag names and class
 *      COUNTS) to logs/claude-patches.log: that line, together with the capture
 *      above, is the ground truth to re-fit this file and
 *      scripts/tests/core/test-extra-settings-dom.mjs against when the remote SPA changes.
 *
 * Upstream content is hidden, never removed: the detected content pane keeps its
 * node and only gets display:none while our panel is mounted next to it, and it
 * is restored when the user clicks any upstream nav item. What we hide is the
 * SCROLLING BODY of the content area, so the modal's own header row - which
 * carries the close button - stays visible next to our panel.
 */
(function () {
  "use strict";

  if (window.__cdbExtraInstalled) return "extra-settings: already installed";

  // Not a hostname check on purpose: 3p / gateway deployments serve a different
  // origin through this same preload. The bindings + our bridge ARE the check.
  var api = window.cdbExtra;
  if (!window.claudeAppBindings || !api || typeof api.flagsCatalog !== "function") {
    return "extra-settings: skipped, no claudeAppBindings/cdbExtra in this view";
  }
  window.__cdbExtraInstalled = true;

  // Labels of upstream settings nav items, lowercased. Only used to LOCATE the
  // nav - a stale entry costs nothing, and the nav is accepted only when at
  // least MIN_HITS of them resolve to a control.
  var NAV_LABELS = [
    "general", "account", "profile", "appearance", "capabilities", "connectors",
    "data controls", "privacy", "notifications", "desktop app", "desktop",
    "keyboard shortcuts", "shortcuts", "integrations", "extensions", "billing",
    "subscription", "plan", "security", "usage", "language", "models",
    "experimental", "developer", "about", "sessions", "memory", "projects",
    "spaces", "skills", "plugins", "personalization", "behavior", "beta",
    "cowork"
  ];

  // Texts upstream uses as GROUP headers, lowercased and in priority order. The
  // first one found becomes the INSERTION ANCHOR (our header and list go
  // immediately before it) and the group whose header and list we clone, so
  // "desktop app" first keeps Extra where it has always been: after the group
  // that ends with Cowork.
  var GROUP_LABELS = ["desktop app", "customize", "settings"];

  // Upstream tags most of its own settings rows with a data-testid. Unlike every
  // entry in NAV_LABELS these are BUILD HOOKS, not user-visible text, so they
  // read the same in every interface language - which is what lets us find the
  // nav in a Spanish or Japanese session where hardly any label matches. Two
  // things about them decide how they may be used: the attribute sits on the
  // CELL (the <li>), not on the control inside it, and whole groups carry none
  // at all (the desktop-only group has no test ids on any row). So they LOCATE
  // the nav, and the rows are then enumerated structurally off the container -
  // enumerating by test id would silently drop the untagged groups.
  // Verified against live claude.ai on 2026-09-10; note that the data-privacy
  // entry is the one id that does not end in "-settings".
  var ROW_TESTID_SEL = '[data-testid$="-settings"],[data-testid="data-privacy-controls"]';

  var MIN_HITS = 3;
  var MIN_PANE_AREA = 20000;

  // A nav row is a CONTROL, never a class: upstream uses <button> inside <li>
  // for settings rows and a bare <a> for the organization link.
  var CONTROL_SEL = 'button,a,[role="button"],[role="tab"],[role="menuitem"],[role="option"]';

  // Upstream row icons are Anthropicons ICON-FONT spans - a 1em flex box whose
  // text is a private-use ligature character. This attribute is the only stable
  // handle on them, and it is what tells the icon box apart from the label span.
  var ICON_SEL = '[data-cds="Icon"]';

  // Attributes upstream may use to mark the selected row, in addition to
  // classes. aria-current is the one the capture shows.
  var SEL_ATTRS = ["aria-current", "aria-selected", "data-state", "data-active"];

  // Attributes that belong to the row we cloned, not to us.
  var CLONE_DROP = ["id", "href", "data-testid", "aria-controls", "aria-labelledby", "aria-describedby"];

  var logged = {};
  function diag(key, message) {
    if (logged[key]) return;
    logged[key] = 1;
    try { api.diag(message); } catch (e) {}
  }

  // --- tiny DOM helpers ----------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // A page with a filter opens ready to type into it. Deferred, because the
  // input is usually appended before its panel is in the document; skipped when
  // the panel has gone again, or when the user has already put the caret in
  // another field (async pages build their filter late).
  function focusFilter(search) {
    setTimeout(function () {
      if (!search.isConnected || search.offsetParent === null) return;
      var a = document.activeElement;
      if (a && a !== search && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      try { search.focus({ preventScroll: true }); } catch (e) {}
    }, 0);
  }

  function area(node) {
    try {
      var r = node.getBoundingClientRect();
      var a = r.width * r.height;
      if (a > 0) return a;
    } catch (e) {}
    return node.offsetWidth * node.offsetHeight;
  }

  // --- nav discovery -------------------------------------------------------

  function isControl(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === "BUTTON" || node.tagName === "A") return true;
    var role = node.getAttribute("role");
    return role === "button" || role === "tab" || role === "menuitem" || role === "option";
  }

  function isList(node) {
    return !!node && (node.tagName === "UL" || node.tagName === "OL");
  }

  function isOurs(node) {
    return node.classList.contains("cdbx-item") ||
      node.classList.contains("cdbx-item-btn") ||
      node.classList.contains("cdbx-group") ||
      !!(node.closest && node.closest(".cdbx-item,.cdbx-group"));
  }

  // The smallest element whose whole text is exactly one known nav label.
  function isLabelLeaf(node) {
    var text = (node.textContent || "").trim();
    if (!text || text.length > 28) return false;
    if (NAV_LABELS.indexOf(text.toLowerCase()) < 0) return false;
    return !hasChildWithSameText(node);
  }

  // The control a label sits in - that IS the nav row. A label leaf that
  // resolves to no control is a GROUP HEADER (upstream's headers are plain text
  // divs), so it drops out here and findAnchor picks it up again.
  function controlFor(node, stop) {
    var n = node;
    var depth = 0;
    while (n && n !== stop && depth++ < 8) {
      if (isControl(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  // The element a list holds. Upstream wraps every settings row in an <li>; the
  // organization link is its own list-less child. Cloning the CELL rather than
  // the control is what lets us append valid <li> children to a cloned <ul>.
  function cellFor(row) {
    var n = row;
    var depth = 0;
    while (n && depth++ < 4) {
      if (n.tagName === "LI") return n;
      if (isList(n)) break;
      n = n.parentElement;
    }
    return row;
  }

  // Locate the nav WITHOUT reading a single word of the interface: the marked
  // cells say which <ul> is a group list, and the parent of the fullest one is
  // the container where headers and lists alternate. Rows are then taken from
  // the container's own structure so that the groups upstream leaves untagged
  // come along with the rest. Returns the same record findNavByLabels does, or
  // null when there are not enough marks to be sure this is the settings nav.
  function findNavByTestId(dialog) {
    var marked = dialog.querySelectorAll(ROW_TESTID_SEL);
    if (marked.length < MIN_HITS) return null;

    var lists = new Map();
    for (var i = 0; i < marked.length; i++) {
      // The mark can sit on the cell itself or on something inside it; the cell
      // is whatever the group list holds directly.
      var cell = marked[i];
      var hops = 0;
      while (cell && !isList(cell.parentElement) && hops++ < 4) cell = cell.parentElement;
      if (!cell || !isList(cell.parentElement) || isOurs(cell)) continue;
      lists.set(cell.parentElement, (lists.get(cell.parentElement) || 0) + 1);
    }
    var primary = null;
    var primaryN = 0;
    lists.forEach(function (n, list) {
      if (n > primaryN) { primaryN = n; primary = list; }
    });
    var container = primary ? primary.parentElement : null;
    if (!container) return null;

    var rows = [];
    var counts = new Map();
    for (var k = 0; k < container.children.length; k++) {
      var kid = container.children[k];
      if (isOurs(kid)) continue;
      if (isList(kid)) {
        var n = 0;
        for (var c = 0; c < kid.children.length; c++) {
          var cell2 = kid.children[c];
          if (isOurs(cell2)) continue;
          var control = isControl(cell2) ? cell2 : cell2.querySelector(CONTROL_SEL);
          if (!control || isOurs(control) || rows.indexOf(control) >= 0) continue;
          rows.push(control);
          n++;
        }
        counts.set(kid, n);
      } else if (isControl(kid) && rows.indexOf(kid) < 0) {
        // The list-less organization link is a direct child of the container.
        rows.push(kid);
      }
    }
    if (rows.length < MIN_HITS) return null;

    var best = null;
    var bestN = 0;
    counts.forEach(function (n, list) {
      if (n > bestN) { bestN = n; best = list; }
    });
    return {
      ok: true, via: "testid", container: container, rows: rows,
      primaryList: best || primary, leaves: rows.length
    };
  }

  // Locate the nav and the ONE container that holds every group: rows are the
  // controls the known labels sit in, and the container is the parent of the
  // biggest row list - which in the capture is exactly the scroll container
  // where group headers and group lists alternate as siblings.
  //
  // Always returns a record. `leaves` is how settings-like the dialog looked at
  // all, which is what tells "this was not the settings modal" (a confirm dialog,
  // a share sheet - stay quiet) apart from "this WAS the settings modal and we
  // failed" (worth one log line).
  function findNavByLabels(dialog) {
    var leaves = [];
    var all = dialog.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (isLabelLeaf(all[i])) leaves.push(all[i]);
    }
    if (leaves.length < MIN_HITS) return { ok: false, leaves: leaves.length, rows: 0 };

    var rows = [];
    for (var j = 0; j < leaves.length; j++) {
      var row = controlFor(leaves[j], dialog);
      if (row && !isOurs(row) && rows.indexOf(row) < 0) rows.push(row);
    }
    if (rows.length < MIN_HITS) return { ok: false, leaves: leaves.length, rows: rows.length };

    var lists = new Map();
    var loose = new Map();
    for (var k = 0; k < rows.length; k++) {
      var parent = cellFor(rows[k]).parentElement;
      if (!parent) continue;
      var bag = isList(parent) ? lists : loose;
      bag.set(parent, (bag.get(parent) || 0) + 1);
    }
    var primary = null;
    var primaryN = 0;
    lists.forEach(function (n, list) {
      if (n > primaryN) { primaryN = n; primary = list; }
    });
    var container = primary ? primary.parentElement : null;
    if (!container) {
      var looseN = 0;
      loose.forEach(function (n, parent) {
        if (n > looseN) { looseN = n; container = parent; }
      });
    }
    if (!container) return { ok: false, leaves: leaves.length, rows: rows.length };
    return {
      ok: true, via: "labels", container: container, rows: rows,
      primaryList: primary, leaves: leaves.length
    };
  }

  // The language-independent path first, because it holds in every locale; the
  // label path stays as the answer for a build that carries no test ids, and it
  // is also the only one that can report how settings-like a dialog looked when
  // nothing was found at all.
  function findNav(dialog) {
    var marked = findNavByTestId(dialog);
    if (marked) return marked;
    return findNavByLabels(dialog);
  }

  function containsAny(node, nodes) {
    for (var i = 0; i < nodes.length; i++) {
      if (node === nodes[i] || node.contains(nodes[i])) return true;
    }
    return false;
  }

  // The content pane: walking up from the nav container, the first large sibling
  // subtree that is no part of the nav itself. Found at click time, when layout
  // is settled. `rows` is what keeps a tall SIBLING GROUP of nav rows from being
  // mistaken for the pane - a pane never contains nav rows.
  function findPane(dialog, container, rows) {
    var node = container;
    var depth = 0;
    while (node && node !== dialog && depth++ < 12) {
      var parent = node.parentElement;
      if (!parent) break;
      var best = null;
      var bestArea = 0;
      for (var i = 0; i < parent.children.length; i++) {
        var kid = parent.children[i];
        if (kid === node || kid.contains(container)) continue;
        if (kid.classList.contains("cdbx-panel") || isOurs(kid)) continue;
        if (containsAny(kid, rows)) continue;
        var a = area(kid);
        if (a > bestArea) { bestArea = a; best = kid; }
      }
      if (best && bestArea >= MIN_PANE_AREA) return scrollBody(best) || best;
      node = parent;
    }
    return null;
  }

  // Take over the pane's SCROLLING BODY rather than the whole pane: the pane's
  // first child is the header row that carries the modal's close button, and
  // hiding that would trap the user in the dialog. Anchored on computed overflow,
  // not on a class, and only accepted when that element is most of the pane -
  // otherwise the pane itself is the honest answer.
  //
  // The scroller is not always a child of the pane: in a live v2.9939.4 capture it
  // sits under a `display: contents` wrapper and a flex column. Looking only at
  // the pane's children found nothing there, hid the WHOLE pane and mounted our
  // panel straight on the dialog card - no close button, and on a see-through
  // window (windowTransparency) no background either. So the search goes down one
  // level at a time and the shallowest scroller that is big enough wins; a
  // nested code block or table that scrolls is never reached while a wider
  // scroller sits above it.
  var SCROLL_SEARCH_DEPTH = 4;
  function scrollBody(pane) {
    var total = area(pane);
    if (!total) return null;
    var level = [pane];
    for (var depth = 0; depth < SCROLL_SEARCH_DEPTH && level.length; depth++) {
      var next = [];
      var best = null;
      var bestArea = 0;
      for (var n = 0; n < level.length; n++) {
        var kids = level[n].children;
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (kid.classList.contains("cdbx-panel") || isOurs(kid)) continue;
          next.push(kid);
          var style = null;
          try { style = getComputedStyle(kid); } catch (e) {}
          if (!style) continue;
          if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
          var a = area(kid);
          if (a > bestArea) { bestArea = a; best = kid; }
        }
      }
      if (best && bestArea >= total * 0.5) return best;
      level = next;
    }
    return null;
  }

  // The row to clone: an UNSELECTED cell of the group we insert next to, so its
  // classes are the plain ones and its icon box is the one we repaint. Cloning
  // the selected row would leave our items looking permanently active. A row
  // that carries an icon is preferred - it is the shape every upstream row has.
  function pickTemplate(list, rows, selected) {
    var cells = [];
    if (list) {
      for (var i = 0; i < list.children.length; i++) {
        var kid = list.children[i];
        if (isOurs(kid)) continue;
        if (isControl(kid) || kid.querySelector(CONTROL_SEL)) cells.push(kid);
      }
    }
    if (!cells.length) {
      for (var j = 0; j < rows.length; j++) {
        var cell = cellFor(rows[j]);
        if (cells.indexOf(cell) < 0) cells.push(cell);
      }
    }
    var plain = null;
    for (var k = cells.length - 1; k >= 0; k--) {
      var candidate = cells[k];
      var control = controlIn(candidate);
      if (!control || control === selected) continue;
      if (isMarkedSelected(control) || isMarkedSelected(candidate)) continue;
      if (control.querySelector(ICON_SEL) || control.querySelector("svg")) return candidate;
      if (!plain) plain = candidate;
    }
    return plain || cells[cells.length - 1] || null;
  }

  // The clickable element of a cell (the cell itself for a list-less row).
  function controlIn(cell) {
    if (isControl(cell)) return cell;
    return cell.querySelector(CONTROL_SEL);
  }

  // The most common control tag among the nav rows. Diffing the selected look
  // only against rows of that tag keeps a differently shaped link (the
  // organization row in the capture) from passing for a second "deviating" row
  // and making the diff ambiguous.
  function majorTag(rows) {
    var counts = {};
    var best = null;
    var bestN = 0;
    for (var i = 0; i < rows.length; i++) {
      var tag = rows[i].tagName;
      counts[tag] = (counts[tag] || 0) + 1;
      if (counts[tag] > bestN) { bestN = counts[tag]; best = tag; }
    }
    return best;
  }

  // Every upstream nav control inside the container, optionally of one tag only.
  function selectionRows(container, tag) {
    var out = [];
    var all = container.querySelectorAll(CONTROL_SEL);
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (isOurs(node)) continue;
      if (tag && node.tagName !== tag) continue;
      out.push(node);
    }
    return out;
  }

  function isMarkedSelected(node) {
    for (var i = 0; i < SEL_ATTRS.length; i++) {
      var v = node.getAttribute(SEL_ATTRS[i]);
      if (v && v !== "false" && v !== "inactive") return true;
    }
    return false;
  }

  function classesOf(node) {
    return Array.prototype.slice.call(node.classList);
  }

  // A clone must carry none of the identity or state of the row it came from:
  // its id and test id would be duplicates, its selection attribute would make
  // our row look active before it is.
  function stripState(root) {
    var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
    for (var i = 0; i < nodes.length; i++) {
      for (var j = 0; j < CLONE_DROP.length; j++) nodes[i].removeAttribute(CLONE_DROP[j]);
      for (var k = 0; k < SEL_ATTRS.length; k++) nodes[i].removeAttribute(SEL_ATTRS[k]);
    }
  }

  // --- icons ---------------------------------------------------------------

  var SVG_NS = "http://www.w3.org/2000/svg";
  var STROKE = {
    fill: "none", stroke: "currentColor", "stroke-width": "1.7",
    "stroke-linecap": "round", "stroke-linejoin": "round"
  };
  var SOLID = { fill: "currentColor", stroke: "none" };

  // Our own glyphs in a 24x24 box, built from primitives rather than one hand
  // written path: every shape carries its own paint attributes, so they render
  // whether the cloned <svg> was fill-based or stroke-based (attributes on a
  // child win over presentation attributes inherited from the svg element).
  var ICON_THEMES = [
    ["rect", { x: "3.2", y: "3.2", width: "7.6", height: "7.6", rx: "2" }, STROKE],
    ["rect", { x: "13.2", y: "3.2", width: "7.6", height: "7.6", rx: "2" }, SOLID],
    ["rect", { x: "3.2", y: "13.2", width: "7.6", height: "7.6", rx: "2" }, SOLID],
    ["rect", { x: "13.2", y: "13.2", width: "7.6", height: "7.6", rx: "2" }, STROKE]
  ];
  var ICON_FEATURES = [
    ["line", { x1: "3.2", y1: "8", x2: "20.8", y2: "8" }, STROKE],
    ["line", { x1: "3.2", y1: "16", x2: "20.8", y2: "16" }, STROKE],
    ["circle", { cx: "15.5", cy: "8", r: "2.6" }, SOLID],
    ["circle", { cx: "8.5", cy: "16", r: "2.6" }, SOLID]
  ];
  // A flag on its pole: Anthropic's own rollout flags, as opposed to the
  // features this package adds next to them.
  var ICON_FLAGS = [
    ["line", { x1: "5.6", y1: "2.8", x2: "5.6", y2: "21.2" }, STROKE],
    ["path", { d: "M5.6 4.4h12.6l-2.9 4.1 2.9 4.1H5.6z" }, SOLID],
    ["line", { x1: "3.2", y1: "21.2", x2: "9.4", y2: "21.2" }, STROKE]
  ];
  // Two stacked backends with a live indicator each: the deployment the app talks
  // to, personal or your own.
  var ICON_DEPLOY = [
    ["rect", { x: "3.2", y: "3.6", width: "17.6", height: "7", rx: "2" }, STROKE],
    ["rect", { x: "3.2", y: "13.4", width: "17.6", height: "7", rx: "2" }, STROKE],
    ["circle", { cx: "7.2", cy: "7.1", r: "1.5" }, SOLID],
    ["circle", { cx: "7.2", cy: "16.9", r: "1.5" }, SOLID]
  ];

  // A model picker with one extra row appended: three rows in a list, the
  // last one marked - the custom model next to Anthropic's own.
  var ICON_MODELS = [
    ["rect", { x: "3.2", y: "3.4", width: "17.6", height: "4.6", rx: "1.6" }, STROKE],
    ["rect", { x: "3.2", y: "9.7", width: "17.6", height: "4.6", rx: "1.6" }, STROKE],
    ["rect", { x: "3.2", y: "16", width: "17.6", height: "4.6", rx: "1.6" }, STROKE],
    ["circle", { cx: "17.4", cy: "18.3", r: "1.5" }, SOLID]
  ];

  // The rows of our nav group, in render order. Everything that builds, binds or
  // dispatches them iterates THIS list, so a new panel is one entry plus one
  // render function.
  var NAV_ITEMS = [
    { kind: "themes", label: "Themes", icon: ICON_THEMES },
    // Short labels: upstream's nav column is narrow and truncates anything
    // longer, so the full name lives in a tooltip and in the panel's own h1.
    { kind: "features", label: "Community", icon: ICON_FEATURES, tooltip: "Community Features" },
    { kind: "models", label: "Models", icon: ICON_MODELS, tooltip: "Custom models" },
    { kind: "flags", label: "Anthropic", icon: ICON_FLAGS, tooltip: "Anthropic Features" },
    { kind: "deploy", label: "Deployment", icon: ICON_DEPLOY }
  ];
  // On Windows (a downstream Windows build of this patch set) only custom
  // models is carried: the other panels drive Linux-only patches or Linux
  // paths (/etc/claude-desktop) that do not exist there.
  var WINDOWS_NAV = { models: true };
  if (/^Win/.test((typeof navigator !== "undefined" && navigator.platform) || "")) {
    NAV_ITEMS = NAV_ITEMS.filter(function (it) { return WINDOWS_NAV[it.kind] === true; });
  }

  function applyAttrs(node, map) {
    Object.keys(map).forEach(function (k) { node.setAttribute(k, map[k]); });
  }

  function shapeNode(spec) {
    var node = document.createElementNS(SVG_NS, spec[0]);
    applyAttrs(node, spec[1]);
    applyAttrs(node, spec[2]);
    return node;
  }

  // Our glyph, sized in the box upstream gave the row: 1em square inside the
  // icon font's own 1em flex box, so it comes out at the row's font-size (20px
  // in the capture) and in the row's color, exactly like the ligature character
  // it replaces.
  function iconSvg(shapes) {
    var svg = document.createElementNS(SVG_NS, "svg");
    applyAttrs(svg, {
      width: "1em", height: "1em", viewBox: "0 0 24 24",
      fill: "currentColor", "aria-hidden": "true", focusable: "false"
    });
    for (var i = 0; i < shapes.length; i++) svg.appendChild(shapeNode(shapes[i]));
    return svg;
  }

  // Upstream's icon box is kept and only its CONTENT becomes ours: the box holds
  // the font-size, the color class and the flex centering we want to inherit,
  // and its text is a ligature character that must go or it renders next to our
  // glyph.
  function paintIconBox(box, shapes) {
    clear(box);
    box.appendChild(iconSvg(shapes));
  }

  // Should upstream ever go back to a real <svg> icon, repaint it in place: the
  // element itself is left alone (its class and its rendered size are upstream's,
  // and that is the whole point), only its children are replaced. viewBox is the
  // one exception - our coordinates are 24x24, so a different box has to be
  // corrected or the glyph is cropped.
  function paintSvgIcon(svg, shapes) {
    clear(svg);
    if ((svg.getAttribute("viewBox") || "") !== "0 0 24 24") {
      svg.setAttribute("viewBox", "0 0 24 24");
    }
    for (var i = 0; i < shapes.length; i++) svg.appendChild(shapeNode(shapes[i]));
  }

  // --- item cloning --------------------------------------------------------

  // Reuse a real nav row so our items inherit upstream styling without ever
  // naming one of its classes. cloneNode does not copy React's per-node props,
  // so the clone carries no upstream behavior - which is exactly what we want,
  // our own listener is attached afterwards.
  //
  // Returns both halves of the row: the CELL is what a list holds, the CONTROL
  // is what gets clicked and what carries the selected look.
  function makeItem(template, text, shapes) {
    var cell = template.cloneNode(true);
    stripState(cell);
    cell.classList.add("cdbx-item");

    var control = controlIn(cell) || cell;
    control.classList.add("cdbx-item-btn");

    // The icon: upstream's font box if there is one, else a real svg, else
    // nothing but a logged line - a row without a glyph still works.
    var keep = control.querySelector(ICON_SEL);
    if (keep) {
      paintIconBox(keep, shapes);
    } else {
      keep = control.querySelector("svg");
      if (keep) paintSvgIcon(keep, shapes);
    }
    if (!keep) {
      diag("no-icon", "[ExtraSettings] the upstream nav row carries no " + ICON_SEL +
        " icon box and no <svg> - Extra items render without a glyph");
    }
    // A trailing chevron, a second glyph or a bitmap belongs to the row we
    // copied, not to ours, and none of them can be repainted: they go.
    var extra = control.querySelectorAll(ICON_SEL + ",img,picture,svg");
    for (var i = 0; i < extra.length; i++) {
      if (keep && (extra[i] === keep || keep.contains(extra[i]))) continue;
      extra[i].remove();
    }

    setLabel(control, text, keep);
    if (control.tagName !== "BUTTON") {
      // A cloned <a> has had its href stripped, so it is neither focusable nor
      // keyboard-activatable on its own.
      control.setAttribute("role", "button");
      control.setAttribute("tabindex", "0");
    }
    return { cell: cell, control: control };
  }

  // One clone per NAV_ITEMS entry, each carrying the kind that picks its panel.
  function makeItems(template) {
    return NAV_ITEMS.map(function (spec) {
      var item = makeItem(template, spec.label, spec.icon);
      // Only the rows whose label had to be shortened carry one: a tooltip that
      // repeats the label it is on is noise.
      if (spec.tooltip) item.control.setAttribute("title", spec.tooltip);
      item.kind = spec.kind;
      return item;
    });
  }

  // The label element, found SEMANTICALLY: the element inside the row that is
  // not the icon box and does not contain it. Writing into the "first text node"
  // instead lands the word INSIDE the icon-font span, where it renders through
  // the Anthropicons stack while the real label span stays empty - the exact bug
  // this file was refitted for (see baseline/SETTINGS_NAV_CAPTURE.md).
  function labelSlot(control, icon) {
    var best = null;
    var bestScore = 0;
    var all = control.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (node.namespaceURI === SVG_NS) continue;
      if (icon && (node === icon || icon.contains(node) || node.contains(icon))) continue;
      if (node.matches(ICON_SEL)) continue;
      if (node.querySelector(ICON_SEL + ",svg,img,picture")) continue;
      // A leaf that already held text is the label; the class hints only break
      // ties, so upstream renaming them costs nothing.
      var score = 1;
      if (!node.children.length) score += 4;
      if ((node.textContent || "").trim()) score += 2;
      if (/(^|\s)(truncate|flex-1|min-w-0)(\s|$)/.test(node.getAttribute("class") || "")) score += 3;
      if (score > bestScore) { bestScore = score; best = node; }
    }
    return best;
  }

  // Our label replaces the cloned one; every other text the row carried (a
  // badge, a description we have no text for) is blanked rather than left to
  // claim it came from us.
  function setLabel(control, text, icon) {
    var slot = labelSlot(control, icon);
    var walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT, null);
    var texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (var i = 0; i < texts.length; i++) {
      if (icon && icon.contains(texts[i])) continue;
      texts[i].nodeValue = "";
    }
    if (slot) {
      slot.textContent = text;
      return true;
    }
    control.appendChild(document.createTextNode(text));
    return false;
  }

  // --- group building ------------------------------------------------------

  // A group header is a DIRECT CHILD of the scroll container that carries a
  // short piece of text and no nav row at all - upstream has no per-group
  // wrapper, so headers and lists are plain alternating siblings and a header is
  // recognisable by what it does NOT contain.
  function isGroupHeader(kid) {
    if (!kid || kid.nodeType !== 1) return false;
    if (isList(kid) || isControl(kid) || isOurs(kid)) return false;
    if (kid.querySelector(CONTROL_SEL)) return false;
    var text = (kid.textContent || "").trim();
    return !!text && text.length <= 40;
  }

  // The insertion anchor: the header our own header and list go immediately in
  // front of, and the header we clone. Three tiers, weakest assumption last.
  //
  // The label tier is first because it is exact - it names the group we want
  // rather than deducing it - and it keeps working if upstream ever drops its
  // test ids. It only works in English, so the two structural tiers behind it
  // carry every other locale. Their `label` is a TOKEN, never the header's own
  // text: that text is translated page content and must not reach a log line.
  function findAnchor(container) {
    var kids = container.children;
    var i;

    // Tier 1 - a group header we know by name.
    for (var g = 0; g < GROUP_LABELS.length; g++) {
      for (i = 0; i < kids.length; i++) {
        if (!isGroupHeader(kids[i])) continue;
        if ((kids[i].textContent || "").trim().toLowerCase() !== GROUP_LABELS[g]) continue;
        return { header: kids[i], label: GROUP_LABELS[g], tier: "label" };
      }
    }

    // Tier 2 - the header that follows the first marked group. On the desktop
    // build that is the desktop-only group's header, i.e. the very same place
    // tier 1 puts us, in any language.
    var marked = container.querySelector(ROW_TESTID_SEL);
    if (marked) {
      var kid = marked;
      var depth = 0;
      while (kid && kid.parentElement !== container && depth++ < 8) kid = kid.parentElement;
      if (kid && kid.parentElement === container && isList(kid) &&
          isGroupHeader(kid.nextElementSibling)) {
        return { header: kid.nextElementSibling, label: "#structure", tier: "structure" };
      }
    }

    // Tier 3 - the last header that is actually followed by a list. Skipping the
    // headers with no list of their own is what keeps us out of the organization
    // section, whose header is followed by a bare link.
    var last = null;
    for (i = 0; i < kids.length; i++) {
      if (!isGroupHeader(kids[i])) continue;
      var next = kids[i].nextElementSibling;
      if (!isList(next) || isOurs(next)) continue;
      last = kids[i];
    }
    if (last) return { header: last, label: "#last-group", tier: "last-group" };

    return null;
  }

  function hasChildWithSameText(node) {
    var text = (node.textContent || "").trim();
    for (var i = 0; i < node.children.length; i++) {
      if ((node.children[i].textContent || "").trim() === text) return true;
    }
    return false;
  }

  // Where the header's text lives: the header element itself, or the innermost
  // descendant that carries all of it. Putting our word there keeps whatever
  // classes upstream gave that element.
  function textSlot(header) {
    var text = (header.textContent || "").trim();
    var node = header;
    var depth = 0;
    while (depth++ < 4) {
      var hit = null;
      for (var i = 0; i < node.children.length; i++) {
        if ((node.children[i].textContent || "").trim() === text) { hit = node.children[i]; break; }
      }
      if (!hit) break;
      node = hit;
    }
    return node;
  }

  // Our group is TWO SIBLINGS, mirroring upstream: a clone of a real group header
  // (only its text becomes "Extra", on an inner span so our rainbow gradient does
  // not disturb upstream's own size and spacing) and a clone of a real group list
  // holding our two cloned rows. The list is cloned SHALLOW: it keeps every class
  // and no upstream row comes along.
  function buildGroup(anchor, list, template) {
    var header = anchor.header.cloneNode(true);
    stripState(header);
    var slot = textSlot(header);
    clear(slot);
    if (slot !== header) {
      var walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT, null);
      var texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      for (var t = 0; t < texts.length; t++) texts[t].nodeValue = "";
    }
    slot.appendChild(el("span", "cdbx-navgroup", "Extra"));
    header.classList.add("cdbx-group", "cdbx-navhdr");

    var ourList = list.cloneNode(false);
    stripState(ourList);
    ourList.classList.add("cdbx-group", "cdbx-navlist");

    var items = makeItems(template);
    for (var i = 0; i < items.length; i++) ourList.appendChild(items[i].cell);

    return {
      header: header, list: ourList, items: items,
      label: anchor.label, fallback: false
    };
  }

  function lastList(container) {
    var found = null;
    for (var i = 0; i < container.children.length; i++) {
      var kid = container.children[i];
      if (isList(kid) && !isOurs(kid)) found = kid;
    }
    return found;
  }

  // Fallback rendering: no group header to anchor on, so the frame is ours -
  // cdbx-navgroup-fb carries the size and spacing upstream would have given it.
  // The rows are still real clones, and whatever the host turns out to be we
  // append a VALID child to it: an <li> divider inside a list, a <div> only
  // inside a non-list. A <div> in a <ul> is what the previous fallback produced,
  // and it is what made the injection misrender.
  function fabricateGroup(container, list, template) {
    var items = makeItems(template);
    var host = list && template.tagName === "LI" ? list : container;
    var header = document.createElement(isList(host) ? "li" : "div");
    header.className = "cdbx-group cdbx-navgroup-fb";
    header.appendChild(el("span", "cdbx-navgroup", "Extra"));
    host.appendChild(header);
    for (var i = 0; i < items.length; i++) host.appendChild(items[i].cell);
    return {
      header: header, list: null, items: items,
      label: "", fallback: true, host: host
    };
  }

  // --- selection state -----------------------------------------------------

  // Upstream marks the selected row with extra classes and/or an attribute - in
  // the capture, aria-current="page" on the BUTTON plus a swap of colour classes.
  // The difference is discovered at runtime by comparing every row against the
  // class shape most of them share, so our item can borrow the real pill instead
  // of an imitation of it. Returns the node plus the exact two-way diff.
  function findSelected(rows) {
    var counts = {};
    var base = null;
    var bestN = 0;
    var candidates = [];
    for (var i = 0; i < rows.length; i++) {
      if (isOurs(rows[i])) continue;
      candidates.push(rows[i]);
      var key = classesOf(rows[i]).sort().join(" ");
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > bestN) { bestN = counts[key]; base = key; }
    }
    if (base === null || candidates.length < 2) return null;
    var baseClasses = base ? base.split(" ") : [];

    var attrHit = null;
    var odd = [];
    for (var j = 0; j < candidates.length; j++) {
      var row = candidates[j];
      var mine = classesOf(row);
      var add = mine.filter(function (c) { return baseClasses.indexOf(c) < 0; });
      var drop = baseClasses.filter(function (c) { return mine.indexOf(c) < 0; });
      var attrs = [];
      for (var a = 0; a < SEL_ATTRS.length; a++) {
        var v = row.getAttribute(SEL_ATTRS[a]);
        if (v && v !== "false" && v !== "inactive") attrs.push({ name: SEL_ATTRS[a], value: v });
      }
      var hit = { node: row, add: add, drop: drop, attrs: attrs };
      if (attrs.length && !attrHit) attrHit = hit;
      if (add.length || drop.length) odd.push(hit);
    }
    // An attribute is unambiguous. A class diff is only trusted when EXACTLY one
    // row deviates from the shared shape: with several deviating rows the diff
    // could just as well be a badge, and borrowing it would be a wrong pill.
    if (attrHit) return attrHit;
    return odd.length === 1 ? odd[0] : null;
  }

  // --- one-time DOM shape diagnostic ---------------------------------------

  // Tag names and class COUNTS only, never a class name and never page text:
  // ground truth for the next refit when the remote SPA changes shape. Compare it
  // against baseline/SETTINGS_NAV_CAPTURE.md, which is the shape this file fits.
  function shapeOf(node, depth) {
    if (!node || node.nodeType !== 1) return "?";
    var tag = (node.namespaceURI === SVG_NS ? node.nodeName : node.tagName).toLowerCase();
    var out = tag + "." + node.classList.length;
    if (depth > 0 && node.children.length) {
      var parts = [];
      var n = Math.min(node.children.length, 4);
      for (var i = 0; i < n; i++) parts.push(shapeOf(node.children[i], depth - 1));
      if (node.children.length > n) parts.push("+" + (node.children.length - n));
      out += "(" + parts.join(",") + ")";
    }
    return out;
  }

  // --- toast ---------------------------------------------------------------

  var toastNode = null;
  var toastTimer = null;
  function toast(message, bad) {
    if (!toastNode) {
      toastNode = el("div", "cdbx-toast");
      document.body.appendChild(toastNode);
    }
    toastNode.textContent = message;
    toastNode.className = "cdbx-toast cdbx-toast-on" + (bad ? " cdbx-toast-bad" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastNode.className = "cdbx-toast";
    }, bad ? 6000 : 2600);
  }

  function failed(result) {
    return !result || result.ok !== true;
  }

  // --- the modal's own surface color ---------------------------------------
  //
  // Everything else in this panel inherits (text from the modal, surfaces mixed
  // out of currentColor), but a <select> cannot: Chromium paints its DROPDOWN
  // POPUP with the select's own background-color and color, and a popup is not
  // composited over the page. With the translucent background the rest of the
  // panel uses, the popup came out white with our inherited white text on it.
  //
  // So resolve the real surface once per mount and hand it to the stylesheet:
  // the first ancestor with an opaque background is the modal's own layer, and
  // the panel's computed color is the ink. color-scheme then tells Chromium how
  // to paint the popup's own chrome (and the scrollbars, and the number-input
  // spinners) instead of assuming a white page.

  function rgbParts(color) {
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(color || "");
    if (!m) return null;
    return {
      r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]),
      a: m[4] === undefined ? 1 : parseFloat(m[4])
    };
  }

  // Rec. 601 is plenty for a light/dark decision and needs no gamma work.
  function isDark(color) {
    var p = rgbParts(color);
    if (!p) return true;
    return (p.r * 0.299 + p.g * 0.587 + p.b * 0.114) < 128;
  }

  function paintSurface(panel) {
    var node = panel;
    var surface = "";
    var depth = 0;
    while (node && depth++ < 14) {
      var bg = "";
      try { bg = getComputedStyle(node).backgroundColor; } catch (e) {}
      var p = rgbParts(bg);
      // A nearly-transparent layer is not the surface the popup would sit on.
      if (p && p.a >= 0.95) { surface = "rgb(" + p.r + "," + p.g + "," + p.b + ")"; break; }
      node = node.parentElement;
    }
    var ink = "";
    try { ink = getComputedStyle(panel).color; } catch (e2) {}
    if (surface) panel.style.setProperty("--cdbx-surface", surface);
    if (ink) panel.style.setProperty("--cdbx-ink", ink);
    // With no opaque ancestor to measure, the ink still says which side we are on.
    panel.style.colorScheme = isDark(surface || (ink && !isDark(ink) ? "rgb(0,0,0)" : "rgb(255,255,255)"))
      ? "dark" : "light";
  }

  // --- file links ----------------------------------------------------------
  // Every panel ends in the files it wrote, and those are clickable: the path
  // opens in the desktop's default handler, the folder button shows it in the
  // file manager. The page passes a LOCATION NAME, never a path - the main side
  // owns the mapping, so nothing here can ask the desktop to open something else.

  // Which of the two config files a path is, so the link opens the file the row
  // NAMES. Hardcoding the location name next to a path that is computed elsewhere
  // is how a link ends up pointing at the wrong file.
  function cfgLocation(path) {
    return /\.jsonc$/.test(path || "") ? "config-jsonc" : "config-json";
  }

  function pathRow(label, path, name) {
    var row = el("div", "cdbx-pathrow");
    if (label) row.appendChild(el("span", "cdbx-pathlbl", label));
    var link = el("button", "cdbx-pathlink", path);
    link.type = "button";
    link.title = "Open " + path;
    var folder = el("button", "cdbx-pathbtn", "folder");
    folder.type = "button";
    folder.title = "Show " + path + " in the file manager";

    function go(how, button) {
      if (!api || typeof api.reveal !== "function") {
        toast("This build's preload cannot open files - copy the path instead.", true);
        return;
      }
      button.disabled = true;
      api.reveal(name, how).then(function (res) {
        button.disabled = false;
        if (failed(res)) { toast("Could not open " + path + ": " + reason(res), true); return; }
        if (res.mode === "folder" && how !== "folder") {
          toast("That file does not exist yet - opened " + res.opened + " instead");
        }
      }, function (err) {
        button.disabled = false;
        toast("Could not open " + path + ": " + (err && err.message ? err.message : String(err)), true);
      });
    }

    link.addEventListener("click", function () { go("open", link); });
    folder.addEventListener("click", function () { go("folder", folder); });
    row.appendChild(link);
    row.appendChild(folder);
    return row;
  }

  function reason(result) {
    if (!result) return "no response from the main process";
    return result.error || "unknown error";
  }

  // --- themes panel --------------------------------------------------------

  // Sections in render order. A section with no themes is omitted entirely.
  // "gaming" is keyed on the entry's category rather than its source, the
  // built-in and community palettes share one "Common" section (the distinction
  // is a packaging detail, not something to pick a theme by), and "other" exists
  // so a source tier we do not know yet is still shown instead of dropped.
  var THEME_SECTIONS = [
    { key: "custom", label: "Your themes" },
    { key: "gaming", label: "Gaming" },
    { key: "common", label: "Common" },
    { key: "other", label: "More" }
  ];

  // Category wins over source, so a gaming palette is in Gaming wherever it came
  // from. An entry with no category (or from a registry that does not report one
  // yet) is bucketed by source exactly as before.
  function themeBucket(entry) {
    if ((entry.category || "") === "gaming") return "gaming";
    var source = entry.source || "";
    if (source === "custom") return "custom";
    if (source === "builtin" || source === "community") return "common";
    return "other";
  }

  function themeName(entry) {
    return (entry.displayName || entry.name || "").toLowerCase();
  }

  // --- ONE TOGGLE ROW, EVERY COMMUNITY FEATURE -----------------------------
  // Every one of our own switches (Source control, Layout, Motion, Shortcuts)
  // is the same widget: a section heading, a titled row with a note and a state
  // line, a role="switch" button, a read call that fills it in, and a write call
  // that flips it and toasts. The only real differences are the strings, the two
  // bridge method names, and how a response maps to on/off. Those are the spec
  // below.
  //
  // ONE SPELLING FOR THE LOCK. Every main-side handler reports a hand-edited
  // .jsonc as `lockedByJsonc` - the page previously spoke of `locked` for one
  // row and `lockedByJsonc` for the other, for no reason beyond the order they
  // were written in.
  //
  // RESTART NOW. A row whose switch only takes effect after a restart passes
  // spec.restartOwed(on, res): true while the saved switch differs from what the
  // running app was started with. The row then carries a "Restart now" button
  // next to its switch, shown exactly while that is true - so every restart row
  // offers it in the same place, right where it was flipped, and a flip and a
  // flip back take it away again.
  //
  // Returns the two nodes it appended so the panel can filter over them, or
  // undefined when the row was skipped - callers must handle that.
  function renderToggleRow(panel, spec) {
    // The bridge half of these switches lives in the mainView preload. On a
    // partially updated install (older preload, newer page) skip the row instead
    // of throwing and taking the whole Community Features panel down with it.
    if (!api || typeof api[spec.read] !== "function" || typeof api[spec.write] !== "function") return;

    var head = el("div", "cdbx-sec-h");
    head.appendChild(el("span", "cdbx-sec-t", spec.section));
    panel.appendChild(head);

    var host = el("div", "cdbx-list");
    var node = el("div", "cdbx-row");
    var main = el("div", "cdbx-row-main");
    var title = el("div", "cdbx-id", spec.title);
    // spec.badge: a pill after the title ("Experimental"), see experimentalBadge().
    if (spec.badge) title.appendChild(experimentalBadge(spec.badge));
    main.appendChild(title);
    main.appendChild(el("div", "cdbx-note", spec.note));
    var stateLine = el("div", "cdbx-state", "Loading...");
    main.appendChild(stateLine);
    node.appendChild(main);

    var aside = el("div", "cdbx-row-aside");
    node.appendChild(aside);
    var toggle = el("button", "cdbx-switch");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", "false");
    toggle.setAttribute("aria-label", spec.ariaLabel);
    toggle.disabled = true;
    aside.appendChild(toggle);
    var restart = null;
    if (typeof spec.restartOwed === "function" && typeof api.appRelaunch === "function") {
      restart = restartButton();
      restart.classList.add("cdbx-hide");
      aside.insertBefore(restart, toggle);
    }

    host.appendChild(node);
    panel.appendChild(host);

    function isOn() { return toggle.getAttribute("aria-checked") === "true"; }
    function syncRestart(res) {
      if (restart) restart.classList.toggle("cdbx-hide", !spec.restartOwed(isOn(), res));
    }

    api[spec.read]().then(function (res) {
      // spec.hideIf(res): a read that says the feature does not exist on this
      // platform removes the row instead of showing it as unavailable.
      if (typeof spec.hideIf === "function" && spec.hideIf(res)) {
        head.remove();
        host.remove();
        return;
      }
      if (failed(res)) {
        stateLine.textContent = "Unavailable: " + reason(res);
        return;
      }
      function describe() { return spec.describe(isOn(), res); }
      toggle.setAttribute("aria-checked", spec.isOn(res) ? "true" : "false");
      syncRestart(res);

      // A hand-edited .jsonc wins the startup merge, so the switch must not
      // pretend it can override it.
      // Truthy, not === true: some handlers answer null rather than false when
      // the .jsonc leaves the key alone.
      if (res.lockedByJsonc) {
        toggle.title = "Edit " + spec.lockFile + " to change this";
        stateLine.textContent = describe() + " - set in " + spec.lockFile;
        return;
      }

      toggle.disabled = false;
      stateLine.textContent = describe();
      toggle.addEventListener("click", function () {
        if (toggle.disabled) return;
        var next = !isOn();
        toggle.disabled = true;
        api[spec.write](spec.writeArg(next)).then(function (r) {
          toggle.disabled = false;
          if (failed(r)) { toast(spec.errorPrefix + reason(r), true); return; }
          toggle.setAttribute("aria-checked", next ? "true" : "false");
          stateLine.textContent = describe();
          syncRestart(res);
          node.classList.add("cdbx-flash");
          setTimeout(function () { node.classList.remove("cdbx-flash"); }, 700);
          toast(spec.toast(next, r));
        }, function (err) {
          toggle.disabled = false;
          toast(spec.errorPrefix + (err && err.message ? err.message : String(err)), true);
        });
      });
    }, function (err) {
      stateLine.textContent = "Unavailable: " + (err && err.message ? err.message : String(err));
    });

    return { head: head, host: host, spec: spec };
  }

  // --- source control: the Code tab's diff view modes ----------------------
  // Ours, and it applies live, so it sits above the GrowthBook list and outside
  // the restart notice - exactly like the Motion row below. The switch is OFF by
  // default: the feature reshapes Anthropic's own diff panel, so it is opt-in and
  // this row is the way to ask for it.
  function renderDiffViewsRow(panel) {
    return renderToggleRow(panel, {
      section: "Source control",
      title: "Diff view modes",
      note: "Adds a scope dropdown to the Code tab's diff panel - Working tree, Branch changes " +
        "(committed work only) and Latest turn - and compares against the branch you actually " +
        "branched from. Also adds an expand/collapse-all button next to it, which keeps expanding " +
        "files as they load while it is on. Off leaves the panel exactly as Anthropic ships it. " +
        "Applies live - an open Code tab picks the change up within a few seconds.",
      ariaLabel: "show the diff view modes dropdown and the expand/collapse-all button",
      read: "diffViewsRead",
      write: "diffViewsSet",
      lockFile: "claude-desktop-extra.jsonc",
      // Opt-in: only an explicit true is on, so a shape we do not understand
      // renders as off rather than claiming a feature that is not running.
      isOn: function (res) { return res.enabled === true; },
      describe: function (on) {
        return on ? "on - dropdown and expand/collapse-all in the diff panel" : "off - stock single view";
      },
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Diff view modes on - the dropdown and expand/collapse-all are back in the diff panel"
          : "Diff view modes off - the diff panel is stock again";
      },
      errorPrefix: "Could not change diff view modes: "
    });
  }

  // --- layout: the Code tab's side-panel tabs -------------------------------
  // Ours, applies live, and off by default: it reshapes how Anthropic's own tile
  // layout is presented, so it is opt-in and this row is the way to ask for it.
  function renderPanelTabsRow(panel) {
    return renderToggleRow(panel, {
      section: "Layout",
      title: "Panel tabs",
      note: "Shows the Code tab's side panels as tabs instead of squeezing them side by side, so " +
        "the panel you are using gets the full width. The rest stay open in the background and keep " +
        "their place, so switching back is instant - that also means a live preview goes on " +
        "running while you are not looking at it. Drag the divider to resize; opening or closing a " +
        "panel will not move it. Off gives you the normal split layout back, and nothing you have " +
        "open is lost. Applies live - an open Code tab picks the change up within a few seconds.",
      ariaLabel: "show the Code tab's side panels as tabs instead of a split layout",
      read: "panelTabsRead",
      write: "panelTabsSet",
      lockFile: "claude-desktop-extra.jsonc",
      // Opt-in: only an explicit true is on, so a shape we do not understand
      // renders as off rather than claiming a feature that is not running.
      isOn: function (res) { return res.enabled === true; },
      describe: function (on) {
        return on ? "on - side panels are tabs" : "off - stock split layout";
      },
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Panel tabs on - the Code tab's side panels are now a tab strip"
          : "Panel tabs off - the side panels are split again";
      },
      errorPrefix: "Could not change panel tabs: "
    });
  }

  // --- files: Ctrl+P quick open over the Files panel -------------------------
  // Ours, opt-in, and off by default: it adds a hotkey and a search box over
  // Anthropic's own Files panel and changes how the file index treats spaces.
  // The hotkey applies live; the index half applies to file-index workers
  // started after the switch flips (upstream restarts them on cwd change / idle),
  // so the note says "or after a restart" rather than pretending it is instant.
  function renderFilesQuickOpenRow(panel) {
    return renderToggleRow(panel, {
      section: "Files",
      title: "Files quick open",
      note: "Ctrl+P on the Code tab opens a VS Code-style quick-open box over the Files panel: " +
        "type part of a name, use the arrow keys or the mouse, press Enter to open it as a file tab. " +
        "Spaces split the query into pieces that must all match, in any order - 'user service' " +
        "finds user-service.spec.ts - and that also fixes the Files panel's own filter and the " +
        "composer's @ file picker. Off leaves the panel and the index exactly as Anthropic ships them. " +
        "The hotkey applies live; the spaces fix reaches the file index on its next start or after a restart.",
      ariaLabel: "open files with Ctrl+P from a quick-open box over the Files panel",
      read: "quickOpenRead",
      write: "quickOpenSet",
      lockFile: "claude-desktop-extra.jsonc",
      isOn: function (res) { return res.enabled === true; },
      describe: function (on) {
        return on ? "on - Ctrl+P quick open, spaces split the search" : "off - stock Files panel and filter";
      },
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Files quick open on - press Ctrl+P on the Code tab"
          : "Files quick open off - the Files panel is stock again";
      },
      errorPrefix: "Could not change Files quick open: "
    });
  }

  // --- models: custom models in the Code picker ------------------------------
  // Ours, applies to the next bootstrap of the page (a reload or a restart of
  // the app) and to sessions started after the flip; open sessions stop
  // routing at once but keep the model slots they were spawned with. The switch only ever
  // toggles `customModels.enabled`; the providers and models are edited in
  // Settings > Extra > Models (or the .jsonc), so the state line says how many
  // it found and the row refuses to turn on when there is nothing to list.
  function renderCustomModelsRow(panel) {
    return renderToggleRow(panel, {
      section: "Models",
      title: "Custom models",
      note: "Adds models from Anthropic-compatible endpoints (DeepSeek, OpenRouter, a gateway) to the Code " +
        "tab's model picker, next to Anthropic's. Sessions on them use your key; everything else stays on " +
        "your subscription. Set up providers and models in Settings > Extra > Models. Applies live: new " +
        "sessions follow the switch, the picker updates when the Code tab reloads, and open sessions stop " +
        "routing at once. A session opened while this was off needs reopening.",
      ariaLabel: "list custom Anthropic-compatible models in the Code model picker",
      read: "customModelsRead",
      write: "customModelsSet",
      lockFile: "claude-desktop-extra.jsonc",
      isOn: function (res) { return res.enabled === true; },
      describe: function (on, res) {
        if (!res || res.configured !== true) return "off - no model configured yet (Settings > Extra > Models)";
        var n = typeof res.models === "number" ? res.models : 0;
        var noKey = (res.providers || []).filter(function (p) { return p && p.keyOk !== true; })
          .map(function (p) { return p.id; });
        var what = n + " model" + (n === 1 ? "" : "s") + " from " + (res.providers || []).length +
          " provider" + ((res.providers || []).length === 1 ? "" : "s") +
          (noKey.length ? " (no API key for " + noKey.join(", ") + ")" : "");
        return on ? "on - " + what : "off - " + what + " configured";
      },
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Custom models on - reload the Code tab to see them in the picker"
          : "Custom models off - the picker is stock again on the next reload";
      },
      errorPrefix: "Could not change custom models: "
    });
  }

  // --- inference: non-Anthropic models through a third-party gateway --------
  // Ours, opt-in, and off by default: it relaxes Anthropic's own check that drops
  // a gateway model whose ID does not look Anthropic from the model list. The
  // list is built at startup, so a saved change applies on the next start; the
  // read response carries what the RUNNING app started with (activeNow) next to
  // the saved value, so describe() says "after a restart" exactly while they
  // differ - the same arrangement as the transcript limits row below.
  function renderDevToolsRow(panel) {
    return renderToggleRow(panel, {
      section: "Developer",
      title: "Developer tools",
      note: "Lets Ctrl+Alt+I open Chromium DevTools for the focused window, and shows \"Toggle Dev " +
        "Tools\" in the app menu. Writes the official build's own opt-in file, developer_settings.json " +
        "in the profile directory, which the app re-reads on every shortcut press - so the shortcut works " +
        "right away; the menu entry appears after a restart. An organization that disabled developer " +
        "mode for its workspace keeps DevTools off regardless.",
      ariaLabel: "allow developer tools (Ctrl+Alt+I)",
      read: "devToolsRead",
      write: "devToolsSet",
      lockFile: "developer_settings.json",
      // Opt-in: only an explicit true is on, exactly like upstream's own check.
      isOn: function (res) { return res.enabled === true; },
      describe: function (on) {
        return on ? "on - Ctrl+Alt+I opens DevTools"
          : "off - DevTools stay disabled, as in the official build";
      },
      writeArg: function (next) { return next; },
      toast: function (next, r) {
        var label = next ? "Developer tools allowed - Ctrl+Alt+I opens them"
          : "Developer tools disabled";
        return r && r.replacedInvalid ? label + " (replaced an unreadable developer_settings.json)" : label;
      },
      errorPrefix: "Could not change the developer tools setting: "
    });
  }

  // --- Computer Use on a background display (issue #300) -------------------
  // Experimental. Display 1 is the user's desktop; display 2 is a second display
  // (Xvfb, Xephyr, a headless sway) the user starts themselves and Computer Use
  // works on instead. The executor reads the key at every Computer Use start, so
  // the switch applies from the next one; the row's "Set up" opens a page of its
  // own in this same panel (candidates, previews, restrictions, recipes, Test).
  // Everything it shows comes from the cuBackground* bridge (main side:
  // cdb-cubg:* in js/extra_settings_main.js), which refuses the user's own
  // display and never takes an env map from here.
  var CUBG_API = ["cuBackgroundRead", "cuBackgroundSet", "cuBackgroundCandidates", "cuBackgroundProbe",
    "cuBackgroundThumbnail", "cuBackgroundTest", "cuBackgroundTools"];

  function cubgApiOk() {
    return !!api && CUBG_API.every(function (n) { return typeof api[n] === "function"; });
  }

  // A small pill after a title. One style for every experimental feature, so
  // the word means the same thing wherever it appears.
  function experimentalBadge(text) {
    var b = el("span", "cdbx-exp", text || "Experimental");
    b.title = "Experimental: works, but may change or be removed";
    return b;
  }

  // The executor is chosen once at startup: on a KDE Plasma session that runs
  // the kwin executor (or would, had the switch been off), a flip only takes
  // effect after a restart. The main side says so in startedWith.
  function cubgRestartOwed(on, res) {
    var sw = res && res.startedWith;
    return !!(sw && sw.restartOnChange === true && typeof sw.enabled === "boolean" && on !== sw.enabled);
  }

  // Where a change applies, said the same way in the row note, the setup
  // page and the toasts: from the next Computer Use start, or - on a KDE
  // session that picked its Computer Use mode at startup - after a restart.
  function cubgKwin(res) {
    return !!(res && res.startedWith && res.startedWith.restartOnChange === true);
  }
  function cubgApplies(res) {
    return cubgKwin(res)
      ? "On this KDE session a change takes effect after a restart: Computer Use picked its mode when the app started."
      : "Applies live, from the next Computer Use start - no restart.";
  }
  function cubgNote(res) {
    return "Claude clicks, types and takes screenshots on a second display you start yourself (Xvfb, " +
      "Xephyr or a headless sway) while you keep working on your own desktop. Choose that display " +
      "with Set up. " + cubgApplies(res) + " While it is on and that display is not running, Computer " +
      "Use refuses to act rather than fall back to your desktop.";
  }

  function cubgName(kind, display) {
    return (kind === "x11" ? "X11 display " : "Wayland display ") + display;
  }

  function renderCuBackgroundRow(panel) {
    // The setup page needs every channel; an older preload gets no row at all.
    if (!cubgApiOk()) return;
    var lastRes = null;
    var noteNode = null;
    var row = renderToggleRow(panel, {
      section: "Computer Use",
      title: "Computer Use on a background display",
      badge: "Experimental",
      note: cubgNote(null),
      ariaLabel: "let Computer Use work on a background display instead of your desktop",
      read: "cuBackgroundRead",
      write: "cuBackgroundSet",
      lockFile: "claude-desktop-extra.jsonc",
      // The downstream Windows build carries this page; its main side answers
      // "Linux only" and the row must not appear there.
      hideIf: function (res) { return failed(res) && /Linux only/.test(reason(res)); },
      isOn: function (res) {
        lastRes = res;
        // The note says where a change applies, which the read just told us.
        if (noteNode && cubgKwin(res)) noteNode.textContent = cubgNote(res);
        return res.enabled === true;
      },
      restartOwed: cubgRestartOwed,
      describe: function (on, res) {
        var cfg = res && res.config;
        var tail = cubgRestartOwed(on, res) ? " - after a restart (this KDE session chose its Computer Use mode at startup)" : "";
        if (on && res && res.valid === false) return "on but invalid: " + res.error + " - Computer Use refuses to act" + tail;
        if (!cfg) return (on ? "on" : "off - no display chosen yet (Set up)") + tail;
        return (on ? "on - " : "off - ") + cubgName(cfg.kind, cfg.display) + (on ? "" : " saved") + tail;
      },
      // Only `enabled` travels: the main side keeps the chosen display.
      writeArg: function (next) { return { enabled: next }; },
      toast: function (next) {
        if (cubgRestartOwed(next, lastRes)) return "Saved - restart the app for it to take effect on this KDE session";
        return next ? "Background display on - applies from the next Computer Use start"
          : "Background display off - Computer Use works on your desktop again from its next start";
      },
      errorPrefix: "Could not change the background display: "
    });
    if (!row) return;
    noteNode = row.host.querySelector(".cdbx-note");
    var aside = row.host.querySelector(".cdbx-row-aside");
    var setup = el("button", "cdbx-btn", "Set up");
    setup.type = "button";
    setup.title = "Choose the display, preview it, test it";
    setup.addEventListener("click", function () { renderCuBackground(panel); });
    if (aside) aside.insertBefore(setup, aside.firstChild);
    return row;
  }

  // A copyable command block. There is no other copy button on these pages;
  // the clipboard API can be refused (no focus, permissions), so a failure
  // selects the text instead and says so.
  function codeBlock(text) {
    var wrap = el("div", "cdbx-cubg-code");
    var pre = el("pre", "cdbx-cubg-pre", text);
    var copy = el("button", "cdbx-btn cdbx-cubg-copy", "Copy");
    copy.type = "button";
    copy.addEventListener("click", function () {
      function fallback() {
        try {
          var r = document.createRange();
          r.selectNodeContents(pre);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        } catch (e) {}
        toast("Selected - press Ctrl+C to copy");
      }
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") { fallback(); return; }
        navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, fallback);
      } catch (e) { fallback(); }
    });
    wrap.appendChild(pre);
    wrap.appendChild(copy);
    return wrap;
  }

  function cubgSection(host, text) {
    var head = el("div", "cdbx-sec-h");
    head.appendChild(el("span", "cdbx-sec-t", text));
    host.appendChild(head);
  }

  // Package names per distro family, for a recipe whose tool is not installed.
  var CUBG_PKGS = {
    Xvfb: "Arch: xorg-server-xvfb - Debian/Ubuntu: xvfb - Fedora/RHEL: xorg-x11-server-Xvfb",
    Xephyr: "Arch: xorg-server-xephyr - Debian/Ubuntu: xserver-xephyr - Fedora: xorg-x11-server-Xephyr",
    wm: "a window manager: xfwm4 or openbox (same package name on Arch, Debian/Ubuntu, Fedora)",
    sway: "sway (Arch, Debian/Ubuntu, Fedora; EPEL on RHEL)",
    x11vnc: "x11vnc (Arch, Debian/Ubuntu, Fedora/EPEL), plus any VNC viewer",
    wayvnc: "wayvnc (Arch, Debian/Ubuntu, Fedora), plus any VNC viewer"
  };

  // The recipes, built for what is installed: the window manager line uses
  // one that is there, the display numbers avoid the ones in use, and a recipe
  // whose tool is missing says which package brings it.
  function cubgRecipes(host, tools, candidates) {
    tools = tools || {};
    var used = {};
    (candidates || []).forEach(function (c) { if (c.kind === "x11") used[c.display] = true; });
    function freeX(start) {
      for (var n = start; n < start + 50; n++) if (!used[":" + n]) { used[":" + n] = true; return ":" + n; }
      return ":" + start;
    }
    var wm = tools.xfwm4 ? "xfwm4" : tools.openbox ? "openbox" : tools.i3 ? "i3" : "";
    var wmLine = wm || "openbox";
    var xd = freeX(99);
    var ed = freeX(98);

    function recipe(title, note, code, missing) {
      var box = el("div", "cdbx-cubg-recipe");
      box.appendChild(el("div", "cdbx-id", title));
      if (note) box.appendChild(el("div", "cdbx-note", note));
      missing.forEach(function (m) { box.appendChild(el("div", "cdbx-note cdbx-cubg-pkg", "Install " + CUBG_PKGS[m])); });
      box.appendChild(codeBlock(code));
      host.appendChild(box);
    }
    var x11Missing = [];
    if (!tools.Xvfb) x11Missing.push("Xvfb");
    if (!wm) x11Missing.push("wm");
    recipe("Invisible X display (Xvfb + a window manager)",
      "Nothing appears on your screen. The window manager lets Claude switch between windows.",
      "Xvfb " + xd + " -screen 0 1600x900x24 -nolisten tcp &\nDISPLAY=" + xd + " " + wmLine + " &", x11Missing);
    var xeMissing = [];
    if (!tools.Xephyr) xeMissing.push("Xephyr");
    if (!wm) xeMissing.push("wm");
    recipe("Visible X display in a window (Xephyr)",
      "Display 2 as a window on your desktop - handy to watch what Claude does.",
      "Xephyr " + ed + " -screen 1600x900 -no-host-grab &\nDISPLAY=" + ed + " " + wmLine + " &", xeMissing);
    recipe("Invisible Wayland display (headless sway)",
      "Its socket appears as a new wayland-N in this list; choose that one.",
      "env -u WAYLAND_DISPLAY -u DISPLAY WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 sway &",
      tools.sway ? [] : ["sway"]);
    recipe("Watch an X display (x11vnc)",
      "Then point a VNC viewer at localhost:5900.",
      "x11vnc -display " + xd + " -localhost -nopw -forever &", tools.x11vnc ? [] : ["x11vnc"]);
    recipe("Watch a Wayland display (wayvnc)",
      "Use the socket name from the list above; then point a VNC viewer at localhost:5901.",
      "WAYLAND_DISPLAY=wayland-1 wayvnc 127.0.0.1 5901 &", tools.wayvnc ? [] : ["wayvnc"]);
  }

  // The probe answer as one line: size, outputs, supported or why not, WM.
  function cubgProbeLine(p) {
    if (failed(p)) return "Unavailable: " + reason(p);
    // A full main-side queue says nothing about the display.
    if (p.busy) return "Busy - too many checks at once; press Refresh";
    if (p.running === false) return "Not running - " + String(p.reason || "no answer").replace(/^not running:\s*/, "");
    if (p.running === null) return "Cannot check - " + (p.reason || "unknown");
    var parts = [];
    if (p.size) parts.push(p.size.width + "x" + p.size.height);
    var outs = (p.screens || []).length;
    parts.push(outs + " output" + (outs === 1 ? "" : "s"));
    parts.push(p.supported ? "supported" : "not supported: " + (p.reason || "unknown"));
    if (p.wm && p.wm.present === true) parts.push("window manager: " + (p.wm.name || "yes"));
    else if (p.wm && p.wm.present === false) parts.push("no window manager");
    if (typeof p.windows === "number") parts.push(p.windows + " window" + (p.windows === 1 ? "" : "s"));
    return parts.join(", ");
  }

  function cubgRestrictions(host, p) {
    var list = (p && p.restrictions) || [];
    if (!list.length) return;
    var ul = el("ul", "cdbx-cubg-restr");
    list.forEach(function (r) { ul.appendChild(el("li", null, r.text)); });
    host.appendChild(ul);
  }

  function cubgImage(host, dataUrl, alt) {
    if (!dataUrl || !/^data:image\/(jpeg|png);base64,/.test(dataUrl)) return;
    var img = el("img", "cdbx-cubg-img");
    img.alt = alt;
    img.src = dataUrl;
    host.appendChild(img);
  }

  // The setup page, drawn into the Community Features panel itself; Back
  // redraws the feature list. Every block fills in from its own async call, so
  // one slow probe never holds up the rest.
  function renderCuBackground(panel) {
    clear(panel);
    var back = el("button", "cdbx-btn cdbx-cubg-back", "Back to Community Features");
    back.type = "button";
    back.addEventListener("click", function () { renderFeatures(panel); });
    panel.appendChild(back);
    var h1 = el("div", "cdbx-h1", "Computer Use on a background display");
    h1.appendChild(experimentalBadge());
    panel.appendChild(h1);
    var intro = "Display 1 is your desktop, where you chat with Claude and keep working. Display 2 is a separate " +
      "display that Claude clicks, types and takes screenshots on, so it never moves your mouse or " +
      "steals your focus. You start display 2 yourself (recipes below) and stop it when you are done; " +
      "this page only chooses it. ";
    var sub = el("div", "cdbx-sub", intro + cubgApplies(null));
    panel.appendChild(sub);
    if (!cubgApiOk()) {
      panel.appendChild(el("div", "cdbx-error",
        "This build's preload does not expose the background display bridge - reinstall to pick it up."));
      return;
    }
    var page = el("div", "cdbx-cubg");
    panel.appendChild(page);
    var status = el("div", "cdbx-empty", "Reading the configuration...");
    page.appendChild(status);
    api.cuBackgroundRead().then(function (st) {
      status.remove();
      if (failed(st)) {
        page.appendChild(el("div", "cdbx-error", "The configuration is unavailable: " + reason(st)));
        return;
      }
      sub.textContent = intro + cubgApplies(st);
      drawCuBackground(panel, page, st);
    }, function (err) {
      status.className = "cdbx-error";
      status.textContent = "The configuration is unavailable: " + (err && err.message ? err.message : String(err));
    });
  }

  function drawCuBackground(panel, page, st) {
    var locked = !!st.lockedByJsonc;
    var cfg = st.config;
    function redraw() { renderCuBackground(panel); }
    function save(arg, okText) {
      return api.cuBackgroundSet(arg).then(function (r) {
        if (failed(r)) { toast("Could not save: " + reason(r), true); return; }
        // The env map a settings file carried belongs to one display; the main
        // side drops it when the display changes and says so.
        toast(okText + (r.envDropped ? " - the env map in the settings file was for the previous display and was removed" : ""));
        redraw();
      }, function (err) {
        toast("Could not save: " + (err && err.message ? err.message : String(err)), true);
      });
    }

    if (locked) {
      var lock = el("div", "cdbx-notice cdbx-info cdbx-cubg-locked");
      lock.appendChild(el("div", "cdbx-notice-title", "Set in claude-desktop-extra.jsonc - read-only here"));
      lock.appendChild(el("div", "cdbx-notice-body",
        "The hand-edited file wins over this page. Edit computerUseBackgroundDisplay there to change it; " +
        "previews and Test still work."));
      if (st.path) lock.appendChild(pathRow("", st.path, cfgLocation(st.path)));
      page.appendChild(lock);
    }

    // A KDE session that chose its executor at startup needs a restart for a
    // change made here (or with the switch) to take effect.
    if (cubgRestartOwed(!!st.enabled, st) && typeof api.appRelaunch === "function") {
      var rn = el("div", "cdbx-notice cdbx-info cdbx-cubg-restart");
      rn.appendChild(el("div", "cdbx-notice-title", "Restart to apply"));
      rn.appendChild(el("div", "cdbx-notice-body",
        "This KDE session chose its Computer Use mode when the app started, so the switch takes effect " +
        "after a restart. Until then Computer Use keeps the mode it started with, or refuses with a restart hint."));
      rn.appendChild(restartButton());
      page.appendChild(rn);
    }

    // The .jsonc could not be read at all: the setting comes from the .json.
    if (st.note) page.appendChild(el("div", "cdbx-note cdbx-warn cdbx-cubg-filenote", st.note));

    // --- status of the configured display ---------------------------------
    cubgSection(page, "Status");
    var stList = el("div", "cdbx-list");
    var stRow = el("div", "cdbx-row");
    var stMain = el("div", "cdbx-row-main");
    stMain.appendChild(el("div", "cdbx-id", cfg ? cubgName(cfg.kind, cfg.display) : "No display chosen"));
    var stLine = el("div", "cdbx-state cdbx-cubg-status");
    stMain.appendChild(stLine);
    stMain.appendChild(el("div", "cdbx-note",
      "While the switch is on, Computer Use works only on this display. If it is not running, every " +
      "Computer Use action is refused - it never falls back to your desktop. Turn the switch off to " +
      "use your desktop again."));
    stRow.appendChild(stMain);
    var stAside = el("div", "cdbx-row-aside");
    var test = el("button", "cdbx-btn cdbx-cubg-test", "Test");
    test.type = "button";
    test.disabled = !cfg;
    test.title = cfg ? "Take a screenshot and move the pointer on " + cfg.display : "Choose a display first";
    var refresh = el("button", "cdbx-btn cdbx-cubg-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", redraw);
    stAside.appendChild(test);
    stAside.appendChild(refresh);
    if (st.enabled && !locked) {
      var off = el("button", "cdbx-btn", "Turn off");
      off.type = "button";
      off.addEventListener("click", function () {
        off.disabled = true;
        save({ enabled: false }, "Background display off - " + (cubgKwin(st)
          ? "restart the app for it to take effect on this KDE session" : "applies from the next Computer Use start"));
      });
      stAside.appendChild(off);
    }
    stRow.appendChild(stAside);
    stList.appendChild(stRow);
    page.appendChild(stList);
    var testOut = el("div", "cdbx-cubg-testout");
    page.appendChild(testOut);

    var sw = st.enabled ? "On" : "Off";
    if (st.enabled && st.valid === false) {
      stLine.textContent = "On, but the setting is invalid: " + st.error + " - Computer Use refuses to act until it is fixed or switched off.";
      stLine.classList.add("cdbx-warn");
    } else if (!cfg) {
      stLine.textContent = sw + " - choose a display below.";
    } else {
      stLine.textContent = sw + " - checking " + cfg.display + "...";
      api.cuBackgroundProbe(cfg.kind, cfg.display).then(function (p) {
        var running = !failed(p) && p.running === true;
        stLine.textContent = sw + " - " + (running ? (p.supported ? "running" : "running but not supported") : "not running") +
          ": " + cubgProbeLine(p) + (st.enabled && !(running && p.supported) ? ". Computer Use refuses to act until it runs." : "");
        stLine.classList.toggle("cdbx-warn", !!st.enabled && !(running && p.supported));
      }, function (err) {
        stLine.textContent = sw + " - could not check: " + (err && err.message ? err.message : String(err));
      });
    }

    test.addEventListener("click", function () {
      test.disabled = true;
      clear(testOut);
      testOut.appendChild(el("div", "cdbx-note", "Testing " + cfg.display + "..."));
      api.cuBackgroundTest().then(function (r) {
        test.disabled = false;
        clear(testOut);
        if (!r || !Array.isArray(r.steps)) {
          testOut.appendChild(el("div", "cdbx-error", "Test failed: " + reason(r)));
          return;
        }
        var ul = el("ul", "cdbx-cubg-steps");
        r.steps.forEach(function (s) {
          ul.appendChild(el("li", s.ok ? null : "cdbx-warn",
            (s.ok ? "ok   " : "FAIL ") + s.name + " (" + s.ms + " ms)" + (s.detail ? " - " + s.detail : "")));
        });
        testOut.appendChild(el("div", r.ok ? "cdbx-note" : "cdbx-note cdbx-warn",
          r.ok ? "Test passed - Computer Use can work on " + r.display + "." : "Test failed: " + reason(r)));
        testOut.appendChild(ul);
        cubgImage(testOut, r.dataUrl, "Screenshot of " + r.display);
      }, function (err) {
        test.disabled = false;
        clear(testOut);
        testOut.appendChild(el("div", "cdbx-error", "Test failed: " + (err && err.message ? err.message : String(err))));
      });
    });

    // --- the displays on this machine --------------------------------------
    cubgSection(page, "Displays");
    var list = el("div", "cdbx-list cdbx-cubg-cands");
    var listNote = el("div", "cdbx-empty", "Looking for displays...");
    page.appendChild(listNote);
    page.appendChild(list);

    // --- recipes ------------------------------------------------------------
    cubgSection(page, "Start display 2");
    var recipes = el("div", "cdbx-cubg-recipes");
    page.appendChild(recipes);

    api.cuBackgroundCandidates().then(function (cr) {
      if (failed(cr)) {
        listNote.className = "cdbx-error";
        listNote.textContent = "Could not list displays: " + reason(cr);
        return;
      }
      var cands = cr.candidates || [];
      var others = cands.filter(function (c) { return !c.own; });
      if (others.length) listNote.remove();
      else listNote.textContent = "No second display found. Start one with a recipe below, then Refresh.";
      cands.forEach(function (c) { list.appendChild(candidateRow(c)); });
      api.cuBackgroundTools().then(function (tr) {
        cubgRecipes(recipes, failed(tr) ? {} : tr.tools, cands);
      }, function () { cubgRecipes(recipes, {}, cands); });
    }, function (err) {
      listNote.className = "cdbx-error";
      listNote.textContent = "Could not list displays: " + (err && err.message ? err.message : String(err));
    });

    // Candidate probes, two at a time: each one runs up to five bridge
    // children, and a machine with many displays must not overflow the main
    // side's queue on page open (that would read as "busy" everywhere).
    var probeQueue = [];
    var probing = 0;
    function probeLimited(kind, display) {
      return new Promise(function (resolve, reject) {
        probeQueue.push(function () {
          probing++;
          api.cuBackgroundProbe(kind, display).then(function (v) { probing--; resolve(v); pump(); },
            function (e) { probing--; reject(e); pump(); });
        });
        pump();
      });
    }
    function pump() {
      while (probing < 2 && probeQueue.length) probeQueue.shift()();
    }

    function candidateRow(c) {
      var wrap = el("div", "cdbx-cubg-cand" + (c.own ? " cdbx-cubg-own" : ""));
      wrap.setAttribute("data-display", c.display);
      var node = el("div", "cdbx-row");
      var main = el("div", "cdbx-row-main");
      var chosen = cfg && cfg.kind === c.kind && cfg.display === c.display;
      main.appendChild(el("div", "cdbx-id", (c.own ? "Display 1 - your desktop (" + c.display + ")" : cubgName(c.kind, c.display)) +
        (chosen ? " - chosen" : "")));
      var line = el("div", "cdbx-state");
      main.appendChild(line);
      node.appendChild(main);
      wrap.appendChild(node);
      if (c.own || !c.selectable) {
        line.textContent = "Where you chat and work - never used as display 2.";
        return wrap;
      }
      var aside = el("div", "cdbx-row-aside");
      var prev = el("button", "cdbx-btn cdbx-cubg-preview", "Show preview");
      prev.type = "button";
      var pick = el("button", "cdbx-btn cdbx-cubg-select", chosen ? "Chosen" : "Select");
      pick.type = "button";
      pick.disabled = locked || chosen;
      if (locked) pick.title = "Set in claude-desktop-extra.jsonc - edit that file to change it";
      aside.appendChild(prev);
      aside.appendChild(pick);
      node.appendChild(aside);
      var extra = el("div", "cdbx-cubg-extra");
      wrap.appendChild(extra);
      var shot = el("div", "cdbx-cubg-shot");
      wrap.appendChild(shot);

      line.textContent = "Checking...";
      probeLimited(c.kind, c.display).then(function (p) {
        line.textContent = cubgProbeLine(p);
        if (!failed(p) && p.running === true && p.supported === false) {
          line.classList.add("cdbx-warn");
          pick.disabled = true;
          pick.title = p.reason || "not supported";
        }
        if (!failed(p) && p.running === true) cubgRestrictions(extra, p);
      }, function (err) {
        line.textContent = "Could not check: " + (err && err.message ? err.message : String(err));
      });

      // On demand only: a screenshot of every display on open would be a
      // burst of captures nobody asked for.
      prev.addEventListener("click", function () {
        prev.disabled = true;
        clear(shot);
        shot.appendChild(el("div", "cdbx-note", "Taking a screenshot..."));
        api.cuBackgroundThumbnail(c.kind, c.display).then(function (t) {
          prev.disabled = false;
          prev.textContent = "Refresh preview";
          clear(shot);
          if (failed(t)) { shot.appendChild(el("div", "cdbx-note cdbx-warn", "No preview: " + reason(t))); return; }
          cubgImage(shot, t.dataUrl, "Preview of " + c.display);
        }, function (err) {
          prev.disabled = false;
          clear(shot);
          shot.appendChild(el("div", "cdbx-note cdbx-warn", "No preview: " + (err && err.message ? err.message : String(err))));
        });
      });

      pick.addEventListener("click", function () {
        if (pick.disabled) return;
        pick.disabled = true;
        save({ enabled: true, kind: c.kind, display: c.display },
          c.display + " chosen and switched on - " + (cubgKwin(st)
            ? "restart the app for it to take effect on this KDE session" : "applies from the next Computer Use start"));
      });
      return wrap;
    }
  }

  function renderAllowNonAnthropicModelsRow(panel) {
    return renderToggleRow(panel, {
      section: "Inference",
      title: "Allow non-Anthropic models",
      note: "Relaxes the built-in check that drops model IDs which do not look Anthropic - " +
        "DeepSeek, Qwen, GLM, Kimi, gpt-oss and the like - from a third-party gateway's model " +
        "list. For 3P/gateway users who route to non-Anthropic models through their own gateway; " +
        "with it off, those routes are silently removed and the session falls back to the default " +
        "model. The setting is per mode: set it while in 3P mode, where it is saved in " +
        "~/.config/Claude-3p. Takes effect after a restart - the model list is built at startup.",
      ariaLabel: "allow non-Anthropic models from a third-party gateway in the model list",
      read: "allowNonAnthropicModelsRead",
      write: "allowNonAnthropicModelsSet",
      lockFile: "claude-desktop-extra.jsonc",
      // Opt-in: only an explicit true is on, so a shape we do not understand
      // renders as off rather than claiming a feature that is not running.
      isOn: function (res) { return res.enabled === true; },
      describe: function (on, res) {
        // `on` is the switch as shown now; res.activeNow is what the running app
        // was started with - they differ for exactly as long as a restart is owed.
        var pending = on !== (res.activeNow === true);
        if (on) {
          return pending ? "on - non-Anthropic gateway models after a restart"
            : "on - the model list keeps non-Anthropic gateway models";
        }
        return pending ? "off - filtered to Anthropic models after a restart"
          : "off - the model list is filtered to Anthropic models";
      },
      restartOwed: function (on, res) { return on !== (res.activeNow === true); },
      writeArg: function (next) { return next; },
      // r.pendingRestart is the main side's answer; only an explicit false (the
      // switch is back where the running app started) drops the restart wording.
      toast: function (next, r) {
        var label = next ? "Non-Anthropic models allowed" : "Non-Anthropic models blocked again";
        return r && r.pendingRestart === false
          ? label + " - no restart needed"
          : label + " - restart Claude Desktop to apply";
      },
      errorPrefix: "Could not change the non-Anthropic model setting: "
    });
  }

  // --- sessions: how much of a big Code session the app loads ---------------
  // Ours, opt-in, and the other kind of row from Files quick open: NOT live. The
  // limits are handed to Anthropic's session manager when it is constructed at
  // startup, so a saved change applies on the next start. The read response
  // carries what the RUNNING app was started with (activeNow / activeMainMiB /
  // activeSubagentMiB) next to the saved value, so describe() can say "after a
  // restart" for exactly as long as that is true, and stop saying it once the
  // app has been restarted. The numbers themselves stay hand-edited in the
  // .jsonc; this row only shows them.
  function renderTranscriptLimitsRow(panel) {
    return renderToggleRow(panel, {
      section: "Sessions",
      title: "Load large sessions in full",
      note: "Anthropic's app loads only the most recent part of a very large session - currently " +
        "the last 50 MiB of the conversation plus 32 MiB shared by its subagents - and hides the " +
        "rest behind \"This session is too large to load in full\". That is typical after long " +
        "sessions with many browser screenshots. On loads up to 256 MiB and 192 MiB by default " +
        "(adjustable in claude-desktop-extra.jsonc), using more memory and time to open a huge " +
        "session. Off leaves the limits exactly as Anthropic ships them. Takes effect after a restart.",
      ariaLabel: "load large Code sessions in full",
      read: "transcriptLimitsRead",
      write: "transcriptLimitsSet",
      lockFile: "claude-desktop-extra.jsonc",
      isOn: function (res) { return res.enabled === true; },
      describe: function (on, res) {
        // `on` is the switch as shown now; res.activeNow is what the running app
        // was started with - they differ for exactly as long as a restart is owed.
        var pending = on !== (res.activeNow === true) ||
          (on && (res.mainMiB !== res.activeMainMiB || res.subagentMiB !== res.activeSubagentMiB));
        var sizes = res.mainMiB + " MiB main, " + res.subagentMiB + " MiB subagents";
        if (on) return pending ? "on - " + sizes + " after a restart" : "on - up to " + sizes;
        return pending ? "off - Anthropic's limits after a restart" : "off - Anthropic's limits";
      },
      restartOwed: function (on, res) {
        return on !== (res.activeNow === true) ||
          (on && (res.mainMiB !== res.activeMainMiB || res.subagentMiB !== res.activeSubagentMiB));
      },
      writeArg: function (next) { return next; },
      // r.pendingRestart is the main side's answer; only an explicit false (the
      // switch is back where the running app started) drops the restart wording.
      toast: function (next, r) {
        var label = next ? "Large sessions on" : "Large sessions off";
        return r && r.pendingRestart === false
          ? label + " - no restart needed"
          : label + " - restart Claude Desktop to apply";
      },
      errorPrefix: "Could not change large-session loading: "
    });
  }

  // --- window: the three window modes ---------------------------------------
  // Two switches, three mutually exclusive outcomes, resolved by the main side
  // as: native titlebar > no window controls > integrated titlebar (default).
  // So the two rows below cannot be read in isolation - a user who sets both
  // would otherwise be left guessing which one the window actually got. The
  // "Hide window controls" row therefore states when the native titlebar has
  // taken it over, and linkWindowRows() keeps that statement true while the
  // page is open. The page NEVER writes the other key to force the issue: the
  // resolution is the window patch's job, this is only the report of it.
  //
  // Both rows are ours, opt-in, and the ONLY rows in this panel that do NOT
  // apply live: frame and controls overlay are decided when the BrowserWindow
  // is constructed, and Electron 44 has no way back - setHasShadow(false) works
  // on a live window, but setTitleBarOverlay(false) throws and there is no
  // setFrame at all. So every note and every toast here says "restart", none
  // of them pretends otherwise, and each row carries renderToggleRow's
  // "Restart now" while its flip is still owed.

  // What the native titlebar pref last read as, and the read response of each
  // row - kept because the cross-row override below outlives the moment
  // renderToggleRow hands a response over. null means "not known yet", which is
  // why describe() below stays neutral until it is: a state line must not claim
  // an override it has not seen.
  var windowNative = null;
  var windowControlsRes = null;
  var windowNativeRes = null;

  // "Is the native titlebar what the window gets?" - which is the saved value
  // OR a launcher flag forcing it, because a flag overrides the other row just
  // as thoroughly as the saved setting does. Only the other row's state line
  // asks this; the native switch itself keeps showing what is saved.
  function nativeInForce() {
    if (windowNativeRes && windowNativeRes.envForced === true) return true;
    return windowNative === true;
  }

  function renderWindowControlsRow(panel) {
    return renderToggleRow(panel, {
      section: "Window",
      title: "Hide window controls",
      note: "Opens the main window with no frame, no minimize/maximize/close buttons and no drop " +
        "shadow. On xfwm4 (XFCE), i3 and Awesome, Chromium draws a thin 4px border inside a " +
        "frameless window, and dropping the controls overlay together with the shadow is the only " +
        "way from inside the app to be rid of it. The price is the buttons: you minimize, maximize " +
        "and close through your window manager instead - Alt+F4 and whatever else it binds. " +
        "Dragging the window edges still resizes as usual. Off keeps the integrated titlebar the " +
        "official build ships, and the native titlebar below wins over this either way. Takes " +
        "effect after a restart - the frame is fixed when the window is created, so nothing " +
        "changes until you quit and reopen Claude Desktop.",
      ariaLabel: "open the main window frameless, without window-control buttons or a shadow",
      read: "windowControlsRead",
      write: "windowControlsSet",
      lockFile: "claude-desktop-extra.jsonc",
      // Opt-in: only an explicit true is on, so a shape we do not understand
      // renders as off rather than claiming a feature that is not running.
      // Called once, with the read response - which linkWindowRows() needs
      // later than renderToggleRow keeps it, to rebuild this row's state line
      // (lock suffix included) when the native switch moves.
      isOn: function (res) { windowControlsRes = res; return res.enabled === true; },
      // Reads the response out of windowControlsRes rather than its own second
      // argument, because linkWindowRows() rebuilds this line from outside too
      // and both paths have to reach the same facts.
      describe: function (on) {
        // Precedence first: while the native titlebar is what the window gets -
        // saved on, or forced on for this run - nothing else about this row is
        // what the user got.
        if (nativeInForce()) {
          return on
            ? "on, but the native titlebar overrides it"
            : "off - overridden by the native titlebar";
        }
        // A launcher flag or env var decides this run whatever is saved, so the
        // line has to say both - the switch keeps showing the saved value.
        if (windowControlsRes && windowControlsRes.envForced === true) {
          return "on for this run by a launcher flag - saved: " + (on ? "on" : "off");
        }
        return on ? "on - no window buttons, no frame" : "off - window buttons, integrated titlebar";
      },
      restartOwed: windowRestartOwed,
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Window controls hidden - restart Claude Desktop to open the window frameless"
          : "Window controls back - restart Claude Desktop to get the titlebar back";
      },
      errorPrefix: "Could not change the window controls: "
    });
  }

  // The main window's see-through mode. The switch is constructor-only
  // (transparent cannot be flipped on a built window), so it says "restart" and,
  // while a flip is still owed, carries "Restart now" next to the switch. The transparency slider below it is live:
  // windowTransparencyLevelPreview re-styles the window while it is dragged,
  // windowTransparencyLevelSet saves windowTransparencyLevel when it is
  // released. Blur is the compositor's job.
  function renderWindowTransparencyRow(panel) {
    var wtRes = null;
    var slider = null;

    var row = renderToggleRow(panel, {
      section: "Window",
      title: "Transparent window",
      note: "Makes the main window see-through so the desktop - and any blur your compositor " +
        "(Hyprland, KWin, ...) applies behind it - shows through the sidebar and the chat area. " +
        "The Transparency slider sets how see-through the surfaces are (higher is more see-through) " +
        "and applies live. A transparent window has " +
        "no minimize/maximize/close buttons and no shadow: close and maximize through your window " +
        "manager (Alt+F4 and friends) and resize by dragging the outermost few pixels of the window. " +
        "On X11 a compositor must be running, or the window turns black. Needs the integrated " +
        "titlebar: it does nothing while the native titlebar is on. The switch takes effect after a restart.",
      ariaLabel: "make the main window transparent",
      read: "windowTransparencyRead",
      write: "windowTransparencySet",
      lockFile: "claude-desktop-extra.jsonc",
      isOn: function (res) {
        wtRes = res;
        if (slider) slider.load(res);
        return res.enabled === true;
      },
      describe: function (on, res) {
        if (res && res.envForced === true) {
          return "decided for this run by CLAUDE_WINDOW_TRANSPARENCY - saved: " + (on ? "on" : "off");
        }
        // The native titlebar won when this window was built, so `active` is
        // false and a restart alone would not apply it.
        if (on && res && res.nativeTitlebar === true) return "on - inactive while the native titlebar is on";
        var line = on ? "on - see-through main window" : "off - opaque window";
        if (res && typeof res.active === "boolean" && res.active !== on) line += " (restart to apply)";
        return line;
      },
      // The window-mode test, minus an "on" the native titlebar blocks - a
      // restart would not close that gap either.
      restartOwed: function (on, res) {
        return windowRestartOwed(on, res) && !(on && res.nativeTitlebar === true);
      },
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Transparent window on - restart Claude Desktop to apply it"
          : "Transparent window off - restart Claude Desktop to get the opaque window back";
      },
      errorPrefix: "Could not change the transparent window: "
    });
    if (!row) return row;

    var node = row.host.querySelector(".cdbx-row");
    var main = node && node.querySelector(".cdbx-row-main");
    if (main && typeof api.windowTransparencyLevelPreview === "function" &&
        typeof api.windowTransparencyLevelSet === "function") {
      slider = renderTransparencySlider(main);
      if (wtRes) slider.load(wtRes);
    }
    return row;
  }

  // The transparency slider of the Transparent window row: 0-90 % in steps of
  // 5, higher = more see-through. `input` previews (throttled to one call in
  // flight plus the latest value), `change` saves. Disabled, with the reason,
  // while the .jsonc or an env variable decides the value (named as read, so a
  // legacy windowOpacity / CLAUDE_WINDOW_OPACITY is named as such). Built
  // disabled; load() fills it in from the row's read response.
  function renderTransparencySlider(main) {
    var wrap = el("div", "cdbx-range");
    var input = el("input", "cdbx-range-input");
    input.type = "range";
    input.min = "0";
    input.max = "90";
    input.step = "5";
    input.value = "20";
    input.disabled = true;
    input.setAttribute("aria-label", "transparent window transparency");
    var value = el("span", "cdbx-range-val", "20%");
    wrap.appendChild(el("span", "cdbx-range-label", "Transparency"));
    wrap.appendChild(input);
    wrap.appendChild(value);
    main.appendChild(wrap);
    var hint = el("div", "cdbx-state cdbx-range-hint", "");
    main.appendChild(hint);

    var res = null;
    var saved = 0.2;
    var inFlight = false;
    var queued = null;

    function pct(l) { return Math.round(l * 100); }
    function show(l) { value.textContent = pct(l) + "%"; }
    function current() { return Math.round(Number(input.value)) / 100; }
    function live() { return !!res && res.active === true; }
    function idleHint() {
      return live() ? "Applies live" : "Saved now - applies once the transparent window is active";
    }

    // One preview in flight at a time; while it runs, only the newest value is
    // kept, so a fast drag costs a handful of restyles, not one per pixel.
    function preview(l) {
      if (!live()) return;
      if (inFlight) { queued = l; return; }
      inFlight = true;
      api.windowTransparencyLevelPreview(l).then(done, done);
      function done() {
        inFlight = false;
        if (queued !== null) { var q = queued; queued = null; preview(q); }
      }
    }

    input.addEventListener("input", function () {
      var l = current();
      show(l);
      preview(l);
    });
    input.addEventListener("change", function () {
      var l = current();
      queued = null;
      api.windowTransparencyLevelSet(l).then(function (r) {
        if (failed(r)) {
          input.value = String(pct(saved));
          show(saved);
          preview(saved);
          toast("Could not change the transparency: " + reason(r), true);
          return;
        }
        saved = typeof r.level === "number" ? r.level : l;
        if (res) res.level = saved;
        input.value = String(pct(saved));
        show(saved);
        hint.textContent = idleHint();
        if (!live()) toast("Transparency " + pct(saved) + "% saved - it applies once the transparent window is active");
      }, function (err) {
        input.value = String(pct(saved));
        show(saved);
        toast("Could not change the transparency: " + (err && err.message ? err.message : String(err)), true);
      });
    });

    return {
      load: function (r) {
        res = r;
        if (typeof r.level === "number" && isFinite(r.level)) saved = r.level;
        input.value = String(pct(saved));
        show(saved);
        var envName = typeof r.levelSetBy === "string" && /^CLAUDE_/.test(r.levelSetBy)
          ? r.levelSetBy : "CLAUDE_WINDOW_TRANSPARENCY_LEVEL";
        var keyName = typeof r.levelSetBy === "string" && /^window/.test(r.levelSetBy)
          ? r.levelSetBy : "windowTransparencyLevel";
        var why = r.levelEnvForced === true
          ? "Set by " + envName + " - unset it to change this here"
          : (r.levelLocked === true ? "Set by " + keyName + " in claude-desktop-extra.jsonc - edit that file to change this" : "");
        input.disabled = !!why;
        input.title = why;
        hint.textContent = why || idleHint();
      }
    };
  }

  // The mode that hands the whole titlebar back to the window manager. It wins
  // over the row above, which is why its own describe() says nothing about what
  // happens when it is off - that is the other row's line to write.
  function renderNativeTitlebarRow(panel) {
    return renderToggleRow(panel, {
      section: "Window",
      title: "Native titlebar",
      note: "Swaps this app's integrated titlebar for your system's own window frame, so the " +
        "titlebar, its buttons and its right-click menu are the ones your window manager draws " +
        "for every other application. It also avoids the thin 4px border xfwm4 (XFCE), i3 and " +
        "Awesome leave behind, because the window is not frameless at all any more - at the cost " +
        "of a second bar above the app's own header. This wins over \"Hide window controls\": with " +
        "both on you get the system frame. Takes effect after a restart - the frame is fixed when " +
        "the window is created, so nothing changes until you quit and reopen Claude Desktop.",
      ariaLabel: "use the system window frame instead of this app's integrated titlebar",
      read: "nativeTitlebarRead",
      write: "nativeTitlebarSet",
      lockFile: "claude-desktop-extra.jsonc",
      // Opt-in, and the value the row above reports its override from - so it is
      // recorded here, where it is first known, rather than read back out of the
      // DOM. The whole response is kept for nativeInForce()'s envForced half.
      isOn: function (res) {
        windowNativeRes = res;
        windowNative = res.enabled === true;
        return windowNative;
      },
      describe: function (on) {
        if (windowNativeRes && windowNativeRes.envForced === true) {
          return "on for this run by a launcher flag - saved: " + (on ? "on" : "off");
        }
        return on ? "on - system window frame" : "off - the titlebar is this app's own";
      },
      restartOwed: windowRestartOwed,
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Native titlebar on - restart Claude Desktop to get the system window frame"
          : "Native titlebar off - restart Claude Desktop to get the integrated titlebar back";
      },
      errorPrefix: "Could not change the native titlebar: "
    });
  }

  // restartOwed for the window-mode rows, whose read reports `active` - what
  // this window was built with. Not owed when nothing had been built yet
  // (active not a boolean), nor when a launcher flag / env var decides every
  // run anyway: a restart cannot close that gap, so offering one would be a
  // false promise.
  function windowRestartOwed(on, res) {
    return !!res && typeof res.active === "boolean" && res.envForced !== true && on !== res.active;
  }

  // The "Restart now" button of every restart row (renderToggleRow's
  // restartOwed slot): app.relaunch() through the bridge, and the button back
  // with a toast when that fails.
  function restartButton() {
    var restart = el("button", "cdbx-btn", "Restart now");
    restart.type = "button";
    restart.title = "Relaunches the app directly, skipping your desktop launcher's systemd scope " +
      "and environment - quitting and reopening from the launcher is the cleanest way";
    restart.addEventListener("click", function () {
      restart.disabled = true;
      restart.textContent = "Restarting...";
      api.appRelaunch().then(function (res) {
        if (failed(res)) {
          restart.disabled = false;
          restart.textContent = "Restart now";
          toast("Could not restart: " + reason(res), true);
        }
      }, function (err) {
        restart.disabled = false;
        restart.textContent = "Restart now";
        toast("Could not restart: " + (err && err.message ? err.message : String(err)), true);
      });
    });
    return restart;
  }

  // The cross-row wiring for the Window group. renderToggleRow renders each row
  // on its own and only ever rewrites its OWN state line, so the one thing these
  // two rows cannot say alone - the override - is done from the outside, on the
  // nodes it hands back. windowNative is filled in by the native row's isOn (and by
  //     our own read below, in case that row is missing), so describe() can
  //     speak to it; every later move of the native switch - which
  //     renderToggleRow only sets after a write succeeds - is picked up and the
  //     other line rewritten. While native wins, the overridden switch is
  //     disabled, because flipping it would write a pref that changes nothing
  //     about the window you get.
  // Nothing here writes a pref: the three modes are resolved by the window
  // patch, this only reports it. A browser without MutationObserver gets the
  // one-shot version: correct on load, stale only after a flip.
  function linkWindowRows(rows) {
    var native = null;
    var controls = null;
    rows.forEach(function (row) {
      if (row.spec.read === "nativeTitlebarRead") native = row;
      if (row.spec.read === "windowControlsRead") controls = row;
    });

    var toggle = controls ? controls.host.querySelector(".cdbx-switch") : null;
    var stateLine = controls ? controls.host.querySelector(".cdbx-state") : null;
    var nativeToggle = native ? native.host.querySelector(".cdbx-switch") : null;
    if (!toggle) return;

    function syncOverride() {
      // Not known yet, or this row's own read has not landed / has failed -
      // in either case its line is not ours to rewrite.
      if (!toggle || !stateLine || windowNative === null) return;
      var text = stateLine.textContent || "";
      if (text === "Loading..." || text.indexOf("Unavailable") === 0) return;

      var locked = !!(windowControlsRes && windowControlsRes.lockedByJsonc);
      var on = toggle.getAttribute("aria-checked") === "true";
      // describe() takes its facts from windowControlsRes, so the rebuild here
      // says exactly what the row's own read path would have said.
      var want = controls.spec.describe(on) +
        (locked ? " - set in " + controls.spec.lockFile : "");
      if (stateLine.textContent !== want) stateLine.textContent = want;

      // Assign only on a real change: this row's own switch is observed below,
      // and rewriting an attribute with the value it already has would notify
      // us right back.
      //
      // Disabled for a SAVED native titlebar, not for a forced one. A saved
      // native is something the user can undo right here, so blocking a write
      // that would change nothing is a kindness; a launcher flag is not, and
      // taking the switch away then would leave no way to set the saved value
      // up for a launch without the flag. The state line tells the truth in
      // both cases regardless.
      var off = windowNative === true || locked;
      if (toggle.disabled !== off) toggle.disabled = off;
      var title = windowNative === true
        ? "The native titlebar is on, and it wins over this"
        : (locked ? "Edit " + controls.spec.lockFile + " to change this" : "");
      if (toggle.title !== title) toggle.title = title;
    }

    // The native row may be absent on a partially updated install (older
    // preload, newer page) - then this read is the only source for the
    // override. It never overwrites what the row's own isOn already
    // established, so with the row present it cannot race it.
    if (api && typeof api.nativeTitlebarRead === "function") {
      api.nativeTitlebarRead().then(function (res) {
        if (!failed(res) && windowNativeRes === null) {
          windowNativeRes = res;
          windowNative = res.enabled === true;
        }
        syncOverride();
      }, function () {});
    }

    if (typeof MutationObserver !== "function") return;
    var observer = new MutationObserver(function (records) {
      // aria-checked on the native switch is a value renderToggleRow writes
      // only from its read or after a write it saw succeed, so every record on
      // it is committed truth - and the ONLY way this page hears about a flip,
      // since isOn() runs once per row.
      for (var i = 0; i < records.length; i++) {
        if (nativeToggle && records[i].target === nativeToggle) {
          windowNative = nativeToggle.getAttribute("aria-checked") === "true";
        }
      }
      syncOverride();
    });
    // The native switch: its read filling in, and every successful flip after.
    if (nativeToggle) {
      observer.observe(nativeToggle, { attributes: true, attributeFilter: ["aria-checked"] });
    }
    // And the other one, so its late read - which enables the switch and writes
    // the line itself - does not undo the override.
    if (toggle) {
      observer.observe(toggle, { attributes: true, attributeFilter: ["aria-checked", "disabled"] });
    }
  }

  // --- tray: always the white glyph -----------------------------------------
  // Off by default, which keeps upstream's own choice. Linux only, like the
  // whole Community panel (not in WINDOWS_NAV).
  function renderTrayIconRow(panel) {
    return renderToggleRow(panel, {
      section: "Tray",
      title: "Always use the white tray icon",
      note: "Off follows the theme like the stock app: a white icon on GNOME and in dark mode, " +
        "a black one in light mode. On keeps it white, for dark panels with a light Claude theme " +
        "or bars that report no color scheme. Applies live.",
      ariaLabel: "always show the white tray icon",
      read: "trayIconRead",
      write: "trayIconSet",
      lockFile: "claude-desktop-extra.jsonc",
      // Opt-in: only an explicit true is on.
      isOn: function (res) { return res.enabled === true; },
      describe: function (on) {
        return on ? "on - always the white icon" : "off - follows the theme";
      },
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Tray icon is now always white"
          : "Tray icon follows the theme again";
      },
      errorPrefix: "Could not change the tray icon: "
    });
  }

  // --- shortcuts: the Ctrl+Shift+T theme gallery ---------------------------
  // The one row here that is ON unless you say otherwise: the shortcut is how a
  // fresh install finds the themes at all, so an absent key means on and only an
  // explicit false takes it away.
  function renderThemePickerRow(panel) {
    return renderToggleRow(panel, {
      section: "Shortcuts",
      title: "Theme picker",
      note: "Ctrl+Shift+T opens a searchable gallery of every theme this build knows about. " +
        "Clicking a card applies it live and saves it; the same chord closes the window again. " +
        "Applies live - the shortcut reads this switch on every press.",
      ariaLabel: "open the theme gallery with Ctrl+Shift+T",
      read: "pickerRead",
      write: "pickerSet",
      lockFile: "claude-desktop-extra.jsonc",
      isOn: function (res) { return res.enabled !== false; },
      describe: function (on) {
        return on ? "on - Ctrl+Shift+T opens the gallery" : "off - the shortcut does nothing";
      },
      writeArg: function (next) { return next; },
      toast: function (next) {
        return next
          ? "Theme picker on - Ctrl+Shift+T opens the gallery"
          : "Theme picker off - Ctrl+Shift+T does nothing";
      },
      errorPrefix: "Could not change the theme picker: "
    });
  }

  // --- the theme overlay row ------------------------------------------------
  // `themeOverlay` merges one theme's tokens over whatever theme is active; the
  // matugen/pywal recipes drive it. Without this row the grid shows the picked
  // theme as active while something else recolors the app and the only way out
  // is the config file. Active: name + Turn off. Inactive with candidates
  // (user/generator themes, hidden ones first): a select + Apply. Inactive with
  // nothing to pick: no row. The bridge half is newer than the page's first
  // release, so a preload without the three calls means no row, not an error.
  function renderOverlayRow(panel, before, onChange) {
    if (!api || typeof api.themesOverlay !== "function" ||
        typeof api.themesOverlays !== "function" || typeof api.themesSetOverlay !== "function") return;

    var head = el("div", "cdbx-sec-h cdbx-hide");
    head.appendChild(el("span", "cdbx-sec-t", "Overlay"));
    var host = el("div", "cdbx-list cdbx-hide");
    panel.insertBefore(head, before);
    panel.insertBefore(host, before);

    var state = { overlay: null, entries: [] };

    function labelOf(name) {
      for (var i = 0; i < state.entries.length; i++) {
        if (state.entries[i].name === name) return state.entries[i].displayName || name;
      }
      return name;
    }

    function fetchState() {
      return Promise.all([api.themesOverlay(), api.themesOverlays()]).then(function (res) {
        var o = res[0], l = res[1];
        state.overlay = (!failed(o) && o.overlay) ? String(o.overlay) : null;
        state.entries = (!failed(l) && Array.isArray(l.entries)) ? l.entries : [];
      }, function () {
        state.overlay = null;
        state.entries = [];
      });
    }

    function draw() {
      clear(host);
      var show = !!state.overlay || state.entries.length > 0;
      head.classList.toggle("cdbx-hide", !show);
      host.classList.toggle("cdbx-hide", !show);
      if (onChange) onChange(state.overlay, state.overlay ? labelOf(state.overlay) : "");
      if (!show) return;

      var node = el("div", "cdbx-row cdbx-overlay-row");
      var main = el("div", "cdbx-row-main");
      var aside = el("div", "cdbx-row-aside");
      node.appendChild(main);
      node.appendChild(aside);
      host.appendChild(node);

      function busy(on) {
        var controls = aside.querySelectorAll("button,select");
        for (var i = 0; i < controls.length; i++) controls[i].disabled = on;
      }
      function set(name) {
        busy(true);
        api.themesSetOverlay(name).then(function (r) {
          if (failed(r)) {
            busy(false);
            toast("Could not change the overlay: " + reason(r), true);
            return;
          }
          fetchState().then(function () {
            draw();
            var where = r.saved || "the config file";
            toast(state.overlay ? "Overlay " + labelOf(state.overlay) + " on - saved to " + where
                                : "Overlay off - saved to " + where);
          });
        }, function (err) {
          busy(false);
          toast("Could not change the overlay: " + (err && err.message ? err.message : String(err)), true);
        });
      }

      if (state.overlay) {
        main.appendChild(el("div", "cdbx-id", "Overlay: " + labelOf(state.overlay)));
        main.appendChild(el("div", "cdbx-note",
          "Merges its colors over every theme you pick, so the active theme below is not quite what is on screen."));
        main.appendChild(el("div", "cdbx-state", "set as themeOverlay in the config file"));
        var off = el("button", "cdbx-btn", "Turn off");
        off.type = "button";
        off.addEventListener("click", function () { set(""); });
        aside.appendChild(off);
        return;
      }

      main.appendChild(el("div", "cdbx-id", "Overlay"));
      main.appendChild(el("div", "cdbx-note",
        "Merge a generated theme's colors over whatever theme you pick - the way a wallpaper-driven " +
        "palette (matugen, pywal, wallust) follows the theme you like."));
      main.appendChild(el("div", "cdbx-state", "off"));
      var select = el("select", "cdbx-select");
      select.setAttribute("aria-label", "theme to merge over the active theme");
      var none = el("option", null, "none");
      none.value = "";
      select.appendChild(none);
      state.entries.forEach(function (e) {
        var opt = el("option", null, e.displayName || e.name);
        opt.value = e.name;
        select.appendChild(opt);
      });
      var go = el("button", "cdbx-btn", "Apply");
      go.type = "button";
      go.disabled = true;
      select.addEventListener("change", function () { go.disabled = !select.value; });
      go.addEventListener("click", function () { if (select.value) set(select.value); });
      aside.appendChild(select);
      aside.appendChild(go);
    }

    fetchState().then(draw);
  }

  function renderThemes(panel) {
    clear(panel);
    panel.appendChild(el("div", "cdbx-h1", "Themes"));
    panel.appendChild(el("div", "cdbx-sub",
      "Every theme this build knows about: built-ins, the bundled community palettes and your own. " +
      "Colors apply live in every window; a theme's custom spinner shape needs a restart."));

    var status = el("div", "cdbx-empty", "Loading themes...");
    panel.appendChild(status);

    api.themesList().then(function (result) {
      if (failed(result)) {
        status.className = "cdbx-error";
        status.textContent = "Themes are unavailable: " + reason(result);
        return;
      }
      status.remove();

      var search = el("input", "cdbx-search");
      search.type = "search";
      search.placeholder = "Filter " + result.entries.length + " themes";
      panel.appendChild(search);
      focusFilter(search);

      var host = el("div", "cdbx-sections");
      panel.appendChild(host);

      // The overlay row sits above the filter. Its callback re-draws the grid so
      // the active card's badge says "overlay" exactly while one is merged.
      var overlayName = null;
      renderOverlayRow(panel, search, function (name) {
        if (name === overlayName) return;
        overlayName = name;
        if (typeof draw === "function") draw(search.value);
      });

      // The file a click here writes to. Which of the two it is depends on what
      // exists on disk, so it comes from the main process and the link follows
      // it - and an apply reports the file it really wrote, which wins.
      var savePath = result.savePath || result.configPath;
      var saveRow = null;
      function drawSaveRow() {
        var row = savePath ? pathRow("Your choice is saved to", savePath, cfgLocation(savePath)) : null;
        if (saveRow && row) panel.replaceChild(row, saveRow);
        else if (row) panel.appendChild(row);
        saveRow = row;
      }
      drawSaveRow();

      var active = result.active || null;

      function card(entry) {
        var node = el("button", "cdbx-card" + (entry.name === active ? " cdbx-on" : ""));
        node.type = "button";

        var dots = el("div", "cdbx-dots");
        (entry.light || []).forEach(function (color) {
          var dot = el("span", "cdbx-dot");
          dot.style.background = color;
          dots.appendChild(dot);
        });
        if ((entry.light || []).length && (entry.dark || []).length) {
          dots.appendChild(el("span", "cdbx-dots-sep"));
        }
        (entry.dark || []).forEach(function (color) {
          var dot = el("span", "cdbx-dot");
          dot.style.background = color;
          dots.appendChild(dot);
        });
        node.appendChild(dots);
        node.appendChild(el("div", "cdbx-cardname", entry.displayName));
        node.appendChild(el("div", "cdbx-badge",
          entry.source + (entry.name === active ? (overlayName ? " - active + overlay" : " - active") : "")));

        node.addEventListener("click", function () {
          api.themesApply(entry.name).then(function (res) {
            if (failed(res)) {
              toast("Could not apply " + entry.displayName + ": " + reason(res), true);
              return;
            }
            active = entry.name;
            draw(search.value);
            // The engine reports the file it actually wrote; if that is not the
            // one we predicted, the row follows it rather than staying wrong.
            if (res.saved && res.saved !== savePath) {
              savePath = res.saved;
              drawSaveRow();
            }
            toast("Applied " + entry.displayName + " - saved to " + (res.saved || "the config file"));
          }, function (err) {
            toast("Could not apply " + entry.displayName + ": " + (err && err.message ? err.message : String(err)), true);
          });
        });
        return node;
      }

      // One pass per keystroke: bucket the matching entries, then render the
      // sections that have any. The filter searches every section at once and a
      // section whose matches are all filtered out disappears with its heading.
      function draw(filter) {
        clear(host);
        var needle = (filter || "").trim().toLowerCase();
        var buckets = {};
        var shown = 0;
        result.entries.forEach(function (entry) {
          if (needle &&
              (entry.displayName || "").toLowerCase().indexOf(needle) < 0 &&
              (entry.name || "").toLowerCase().indexOf(needle) < 0 &&
              (entry.category || "").toLowerCase().indexOf(needle) < 0) return;
          var key = themeBucket(entry);
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push(entry);
          shown++;
        });

        THEME_SECTIONS.forEach(function (section) {
          var list = buckets[section.key];
          if (!list || !list.length) return;
          list.sort(function (a, b) {
            var an = themeName(a), bn = themeName(b);
            return an < bn ? -1 : an > bn ? 1 : 0;
          });
          var head = el("div", "cdbx-sec-h");
          head.appendChild(el("span", "cdbx-sec-t", section.label));
          head.appendChild(el("span", "cdbx-sec-n", String(list.length)));
          host.appendChild(head);
          var grid = el("div", "cdbx-grid");
          list.forEach(function (entry) { grid.appendChild(card(entry)); });
          host.appendChild(grid);
        });

        if (!shown) host.appendChild(el("div", "cdbx-empty", "No theme matches that filter."));
      }

      search.addEventListener("input", function () { draw(search.value); });
      draw("");
    }, function (err) {
      status.className = "cdbx-error";
      status.textContent = "Themes are unavailable: " + (err && err.message ? err.message : String(err));
    });
  }

  // --- community features panel --------------------------------------------
  // Only our own switches live here, and all but the two window modes apply
  // live - which is why this panel has no standing restart notice, only the
  // per-row "Restart now" each restart row shows while the running app and the
  // saved setting disagree. Anthropic's own flags, which always need a restart,
  // are a nav entry of their own and carry a permanent notice.
  //
  // "Applies live" was verified per row, not assumed - each live row's note says
  // so, and this is where each one gets it from:
  //   * diff view modes - the main side flips its own `prefEnabled` inside the
  //     pref-set handler and replays upstream's invalidation (nudgeRefetch), so
  //     the git IPC rewrite stops or starts at once; the page half re-reads
  //     state() on a 5s poll and mounts or tears down the dropdown and the
  //     expand button with it.
  //   * panel tabs - same shape: the page half polls state() every 5s and
  //     setEnabled(false) removes the tab bar and untags the columns.
  //   * theme picker - the hotkey re-reads the config file on every press.
  //   * tray icon - the set handler re-runs upstream's crash-contained tray
  //     update (globalThis.__cdbTrayRefresh), which re-asks the patched selector.
  // The two polled ones are the reason their notes promise "within a few
  // seconds" rather than "instantly".
  //
  // The two exceptions are the Window rows, and they are exceptions in the
  // other direction, verified just as concretely: frame, controls overlay and
  // native titlebar are all BrowserWindow constructor options, and Electron 44
  // has no live setter for any of them - setHasShadow(false) works, but
  // setTitleBarOverlay(false) throws and setFrame does not exist. So those two
  // notes and toasts say "after a restart", and each row's "Restart now"
  // appears for exactly as long as that restart is still owed. The same goes for
  // the transparent window, the transcript limits and the non-Anthropic models
  // rows, which are read once at startup.

  var FEATURE_ROWS = [
    renderDiffViewsRow,
    renderPanelTabsRow,
    renderFilesQuickOpenRow,
    renderCustomModelsRow,
    renderAllowNonAnthropicModelsRow,
    renderTranscriptLimitsRow,
    renderWindowControlsRow,
    renderNativeTitlebarRow,
    renderWindowTransparencyRow,
    renderTrayIconRow,
    renderThemePickerRow,
    renderDevToolsRow,
    renderCuBackgroundRow
  ];

  function renderFeatures(panel) {
    clear(panel);
    panel.appendChild(el("div", "cdbx-h1", "Community Features"));
    panel.appendChild(el("div", "cdbx-sub",
      "Optional features this package adds on top of the official build - each applies live unless its " +
      "row says it needs a restart."));

    var search = el("input", "cdbx-search");
    search.type = "search";
    panel.appendChild(search);

    var rows = [];
    FEATURE_ROWS.forEach(function (render) {
      // renderToggleRow answers nothing when the bridge half of a row is missing
      // (older preload, newer page) - such a row is simply not there to filter.
      var row = render(panel);
      if (row) rows.push(row);
    });
    // The two Window rows are three mutually exclusive modes and the only rows
    // that outlive a flip, so they are the one pair here that cannot report
    // itself row by row.
    linkWindowRows(rows);
    search.placeholder = "Filter " + rows.length + " features by name or description";
    // Nothing to filter is not a filter bar: an install whose preload predates
    // every one of these switches gets the explanation below instead.
    if (!rows.length) search.style.display = "none";
    else focusFilter(search);

    var empty = el("div", "cdbx-empty", rows.length
      ? "No feature matches that filter."
      : "No community features are available in this build - reinstall to pick them up.");
    empty.style.display = "none";
    panel.appendChild(empty);

    // Hide, never re-render: each row fills itself in from an async read over
    // IPC, so redrawing on every keystroke would re-fire all of them and reset
    // switches the user just flipped.
    function draw(filter) {
      var needle = (filter || "").trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (row) {
        var hay = (row.spec.section + " " + row.spec.title + " " + row.spec.note).toLowerCase();
        var hit = !needle || hay.indexOf(needle) >= 0;
        row.head.style.display = hit ? "" : "none";
        row.host.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      empty.style.display = shown ? "none" : "";
    }

    search.addEventListener("input", function () { draw(search.value); });
    draw("");

    // The config file this page answers to, presented exactly as the other two
    // panels present theirs: ONLY the .jsonc is linked, because that is the file
    // a human edits and the one whose value wins per key - a switch it sets
    // renders locked and says so. The .json these switches are persisted to is
    // internal bookkeeping and is deliberately not advertised, the same call the
    // flag list makes. Appended last, after the rows, so it reads as a footnote;
    // a failure is silent because a missing footnote is not worth an error box.
    if (api && typeof api.paths === "function") {
      api.paths().then(function (res) {
        if (failed(res)) return;
        var paths = (res && res.paths) || {};
        if (!paths.jsonc) return;
        panel.appendChild(pathRow("Switches you set by hand here win over this page",
          paths.jsonc, cfgLocation(paths.jsonc)));
      }, function () {});
    }
  }

  // --- models: Anthropic-compatible endpoints in the Code picker -------------
  // The editor behind the "Custom models" switch of Community Features: the
  // providers (endpoint + key) and the models each one serves. Everything the
  // panel writes goes to claude-desktop-extra.json, except the key, which the
  // main side keeps in a 0600 secrets file and never sends back here - the
  // field is write-only, like the Deployment panel's credentials. A provider
  // that lives in the hand-edited .jsonc is shown locked.
  var EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

  function renderModels(panel) {
    clear(panel);
    panel.appendChild(el("div", "cdbx-h1", "Custom models"));
    panel.appendChild(el("div", "cdbx-sub",
      "Models from Anthropic-compatible endpoints (DeepSeek, OpenRouter, a gateway) in the Code tab's model " +
      "picker, next to Anthropic's. A session on one of them talks to that provider with your key; everything " +
      "else stays on your subscription. Sub-agents and workflows can use them too."));

    if (!api || typeof api.customModelsConfig !== "function") {
      panel.appendChild(el("div", "cdbx-error",
        "This build's preload does not expose the custom models bridge - reinstall to pick it up."));
      return;
    }

    var status = el("div", "cdbx-empty", "Reading the configuration...");
    panel.appendChild(status);
    api.customModelsConfig().then(function (state) {
      if (failed(state)) {
        status.className = "cdbx-error";
        status.textContent = "The configuration is unavailable: " + reason(state);
        return;
      }
      status.remove();
      drawModels(panel, state);
    }, function (err) {
      status.className = "cdbx-error";
      status.textContent = "The configuration is unavailable: " + (err && err.message ? err.message : String(err));
    });
  }

  function drawModels(panel, state) {
    var host = el("div", "cdbx-models");
    panel.appendChild(host);

    // The last state drawn, for messages that depend on the switch.
    var lastState = state;
    function offHint() {
      return lastState && lastState.configured && !lastState.enabled ? " - turn custom models on above to list it" : "";
    }
    // Every write comes back with the fresh state, so the panel simply
    // redraws from what the main side reports rather than patching the DOM.
    function refresh(res) {
      if (failed(res)) { toast("Could not save: " + reason(res), true); return false; }
      lastState = res;
      clear(host);
      draw(res);
      return true;
    }
    function call(name) {
      var args = Array.prototype.slice.call(arguments, 1);
      return api[name].apply(api, args).then(refresh, function (err) {
        toast("Could not save: " + (err && err.message ? err.message : String(err)), true);
        return false;
      });
    }

    // The window a provider's preset states, if it states one (the hint under
    // the model form's Context window says where the default comes from).
    function presetContext(p, st) {
      var pr = p.preset && (st.presets || []).filter(function (x) { return x.id === p.preset; })[0];
      return pr && pr.context ? pr.context : "";
    }
    function draw(st) {
      // --- the switch: the Community Features row, drawn here too -------------
      // Same row, same switch; off but configured, a warning says nothing on
      // the page is in use, so a configured page is never mistaken for a live one.
      var stList = el("div", "cdbx-list");
      var stRow = el("div", "cdbx-row cdbx-models-status");
      var stMain = el("div", "cdbx-row-main");
      stMain.appendChild(el("div", "cdbx-id", "Custom models"));
      var stateLine = el("div", "cdbx-state");
      var n = st.models;
      var usable = (st.providers || []).filter(function (p) { return p.models.length; }).length;
      if (!st.configured) {
        stateLine.textContent = "No model configured yet - add a provider and a model below.";
      } else if (st.enabled) {
        stateLine.textContent = "On - " + n + " model" + (n === 1 ? "" : "s") + " from " + usable +
          " provider" + (usable === 1 ? "" : "s") + " in the Code picker" +
          (st.lockedByJsonc ? " (switch set in claude-desktop-extra.jsonc)" : "");
      } else {
        stateLine.textContent = "Off - " + n + " model" + (n === 1 ? "" : "s") + " configured but not listed" +
          (st.lockedByJsonc ? " (switch set in claude-desktop-extra.jsonc)" : "");
      }
      stMain.appendChild(stateLine);
      if (st.configured && !st.enabled) {
        stMain.appendChild(el("div", "cdbx-note cdbx-models-off",
          "Nothing on this page is in use while the switch is off: the picker does not list these models and " +
          "no session is routed. The settings below are kept for when it is on."));
      }
      stRow.appendChild(stMain);
      var stAside = el("div", "cdbx-row-aside");
      var flip = el("button", "cdbx-switch cdbx-models-switch");
      flip.type = "button";
      flip.setAttribute("role", "switch");
      flip.setAttribute("aria-checked", st.enabled ? "true" : "false");
      flip.setAttribute("aria-label", "custom models in the Code model picker");
      flip.disabled = !st.configured || !!st.lockedByJsonc;
      if (!st.configured) flip.title = "Add a provider and a model first";
      else if (st.lockedByJsonc) flip.title = "Set in claude-desktop-extra.jsonc - edit that file to change it";
      flip.addEventListener("click", function () {
        if (flip.disabled) return;
        flip.disabled = true;
        api.customModelsSet(!st.enabled).then(function (r) {
          if (failed(r)) { flip.disabled = false; toast("Could not change custom models: " + reason(r), true); return; }
          toast(st.enabled ? "Custom models off - open sessions stop routing now; the picker is stock again on the next reload"
            : "Custom models on - reload the Code tab to see them in the picker");
          call("customModelsConfig");
        });
      });
      stAside.appendChild(flip);
      stRow.appendChild(stAside);
      stList.appendChild(stRow);
      host.appendChild(stList);
      if (st.configured && !st.lockedByJsonc) {
        // The picker is drawn from the page's bootstrap: a new model shows up
        // there after a reload of the Code tab (the routing itself is live).
        var reload = el("button", "cdbx-btn cdbx-models-reload", "Reload the Code tab");
        reload.type = "button";
        reload.title = "Reloads this page so the model picker lists the current models. Open sessions keep running.";
        reload.addEventListener("click", function () {
          // Close the settings dialog first (Escape, as the user would), or the
          // reloaded page opens it again on its first section.
          try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true })); } catch (e) {}
          // Cancelable: the DOM tests listen and stop the real reload.
          if (!document.dispatchEvent(new CustomEvent("cdbx:reload", { cancelable: true }))) return;
          setTimeout(function () {
            try { window.location.reload(); } catch (e) { toast("Could not reload: " + (e && e.message ? e.message : String(e)), true); }
          }, 120);
        });
        host.appendChild(reload);
      }

      // --- providers ----------------------------------------------------------
      var h = el("div", "cdbx-sec-h");
      h.appendChild(el("span", "cdbx-sec-t", "Providers"));
      h.appendChild(el("span", "cdbx-sec-n", String((st.providers || []).length)));
      host.appendChild(h);
      if (!(st.providers || []).length) {
        host.appendChild(el("div", "cdbx-empty", "None yet."));
      }
      (st.providers || []).forEach(function (p) { host.appendChild(providerCard(p, st)); });

      // --- add a provider: a button, the form opens under it like Add a model
      var addProv = el("button", "cdbx-btn cdbx-models-add-provider", "Add a provider");
      addProv.type = "button";
      addProv.addEventListener("click", function () {
        if (host.querySelector(".cdbx-models-form-provider-new")) return;
        var f = providerForm(null, st);
        f.classList.add("cdbx-models-form-provider-new");
        host.insertBefore(f, addProv.nextSibling);
      });
      host.appendChild(addProv);

      // --- web search: one app-wide choice ------------------------------------
      // The CLI answers every web search with a separate one-tool request to a
      // small Anthropic model, whatever the session's model. This picks the
      // custom model that request goes to instead - or leaves it to Anthropic.
      var hw = el("div", "cdbx-sec-h");
      hw.appendChild(el("span", "cdbx-sec-t", "Web search"));
      host.appendChild(hw);
      var wsRow = el("div", "cdbx-row");
      var wsMain = el("div", "cdbx-row-main");
      wsMain.appendChild(el("div", "cdbx-id", "Web search model"));
      wsMain.appendChild(el("div", "cdbx-note",
        "Every web search in a Code session is a separate request the CLI sends to a small Anthropic model. " +
        "Send it to one of your custom models instead, or to another Claude model. Only models with the web " +
        "search tool are offered. Applies at once, open sessions included."));
      if (st.searchConflict) wsMain.appendChild(el("div", "cdbx-note cdbx-models-warn", st.searchConflict));
      wsRow.appendChild(wsMain);
      var wsAside = el("div", "cdbx-row-aside");
      var wsSel = el("select", "cdbx-select cdbx-models-websearch");
      var wsNone = el("option", "", "Anthropic's default");
      wsNone.value = "";
      wsSel.appendChild(wsNone);
      (st.providers || []).forEach(function (p) {
        p.models.forEach(function (m) {
          if (m.webSearch === false) return;
          var o = el("option", "", p.id + " / " + m.name);
          o.value = m.alias;
          wsSel.appendChild(o);
        });
      });
      (st.anthropicModels || []).forEach(function (m) {
        var o = el("option", "", "Anthropic / " + m.name);
        o.value = m.id;
        wsSel.appendChild(o);
      });
      wsSel.value = st.webSearch || "";
      if (wsSel.value !== (st.webSearch || "")) wsSel.value = "";
      wsSel.disabled = !!st.webSearchLocked;
      if (st.webSearchLocked) wsSel.title = "Set in claude-desktop-extra.jsonc - edit that file to change it";
      wsSel.addEventListener("change", function () {
        wsSel.disabled = true;
        call("customModelsWebSearchSet", wsSel.value).then(function (okd) {
          if (okd) toast(wsSel.value ? "Web searches now go to " + wsSel.options[wsSel.selectedIndex].textContent
            : "Web searches back on Anthropic's default");
          else wsSel.disabled = false;
        });
      });
      wsAside.appendChild(wsSel);
      wsRow.appendChild(wsAside);
      host.appendChild(wsRow);

      // --- small/fast model: the CLI's ANTHROPIC_SMALL_FAST_MODEL slot --------
      // Covers WebFetch page synthesis, the mid-turn intent classifier, and -
      // when the web-search model above is unset - the web-search sub-request.
      var hf = el("div", "cdbx-sec-h");
      hf.appendChild(el("span", "cdbx-sec-t", "Small / fast model"));
      host.appendChild(hf);
      var sfRow = el("div", "cdbx-row");
      var sfMain = el("div", "cdbx-row-main");
      sfMain.appendChild(el("div", "cdbx-id", "Small / fast model"));
      sfMain.appendChild(el("div", "cdbx-note",
        "The model the CLI uses for light background work: WebFetch's page summary, the classifier that runs " +
        "during a turn, and web searches when no web search model is set above. Point it at a custom model to " +
        "keep that work off your subscription, or at another Claude model. Takes effect when a session opens."));
      sfRow.appendChild(sfMain);
      var sfAside = el("div", "cdbx-row-aside");
      var sfSel = el("select", "cdbx-select cdbx-models-smallfast");
      var sfNone = el("option", "", "Anthropic's default");
      sfNone.value = "";
      sfSel.appendChild(sfNone);
      (st.providers || []).forEach(function (p) {
        p.models.forEach(function (m) {
          var o = el("option", "", p.id + " / " + m.name);
          o.value = m.alias;
          sfSel.appendChild(o);
        });
      });
      (st.anthropicModels || []).forEach(function (m) {
        var o = el("option", "", "Anthropic / " + m.name);
        o.value = m.id;
        sfSel.appendChild(o);
      });
      var sfCur = (st.smallFastModel || "").replace(/\[1m\]$/, "");
      sfSel.value = sfCur;
      if (sfSel.value !== sfCur) sfSel.value = "";
      sfSel.disabled = !!st.smallFastModelLocked;
      if (st.smallFastModelLocked) sfSel.title = "Set in claude-desktop-extra.jsonc - edit that file to change it";
      sfSel.addEventListener("change", function () {
        sfSel.disabled = true;
        call("customModelsSmallFastSet", sfSel.value).then(function (okd) {
          if (okd) toast(sfSel.value ? "Small/fast work now goes to " + sfSel.options[sfSel.selectedIndex].textContent
            : "Small/fast work back on Anthropic's default");
          else sfSel.disabled = false;
        });
      });
      sfAside.appendChild(sfSel);
      sfRow.appendChild(sfAside);
      host.appendChild(sfRow);

      // --- sub-agents ---------------------------------------------------------
      // Each model is also a sub-agent type Claude launches by name (its row
      // says which; the model form edits it). Two app-wide choices here: the
      // model of the sub-agents that name none, and the system-prompt line.
      // Both are handed to the CLI when a session opens, unlike the routing.
      var hs = el("div", "cdbx-sec-h");
      hs.appendChild(el("span", "cdbx-sec-t", "Sub-agents"));
      host.appendChild(hs);
      var saRow = el("div", "cdbx-row");
      var saMain = el("div", "cdbx-row-main");
      saMain.appendChild(el("div", "cdbx-id", "Default sub-agent model"));
      saMain.appendChild(el("div", "cdbx-note",
        "Every model above is also a sub-agent type Claude can launch by name. This sets the model of " +
        "sub-agents that name none: Claude Code's general-purpose and Plan types, and a workflow's agent() " +
        "without a model. Explore is pinned to the session's model. Read when a session opens."));
      saRow.appendChild(saMain);
      var saAside = el("div", "cdbx-row-aside");
      var saSel = el("select", "cdbx-select cdbx-models-subagent");
      var saNone = el("option", "", "Claude Code's default");
      saNone.value = "";
      saSel.appendChild(saNone);
      (st.providers || []).forEach(function (p) {
        p.models.forEach(function (m) {
          var o = el("option", "", p.id + " / " + m.name);
          o.value = m.alias;
          saSel.appendChild(o);
        });
      });
      var saCur = (st.subagentModel || "").replace(/\[1m\]$/, "");
      saSel.value = saCur;
      if (saSel.value !== saCur) saSel.value = "";
      saSel.disabled = !!st.subagentModelLocked;
      if (st.subagentModelLocked) saSel.title = "Set in claude-desktop-extra.jsonc - edit that file to change it";
      saSel.addEventListener("change", function () {
        saSel.disabled = true;
        call("customModelsSubagentSet", saSel.value).then(function (okd) {
          if (okd) toast(saSel.value ? "New sessions run unnamed sub-agents on " + saSel.options[saSel.selectedIndex].textContent
            : "Unnamed sub-agents back on Claude Code's default");
          else saSel.disabled = false;
        });
      });
      saAside.appendChild(saSel);
      saRow.appendChild(saAside);
      host.appendChild(saRow);

      var anRow = el("div", "cdbx-row");
      var anMain = el("div", "cdbx-row-main");
      anMain.appendChild(el("div", "cdbx-id", "Tell Claude about custom models"));
      anMain.appendChild(el("div", "cdbx-note",
        "Adds one line to the system prompt of every new session: the ids, the sub-agent types and how to use " +
        "them in the Agent tool and in workflows. Without it Claude only knows what your CLAUDE.md says."));
      if (st.announce && st.announceText) {
        var anText = el("div", "cdbx-note cdbx-models-announce", st.announceText);
        anMain.appendChild(anText);
      }
      anRow.appendChild(anMain);
      var anAside = el("div", "cdbx-row-aside");
      var anBox = el("button", "cdbx-switch cdbx-models-announce-box");
      anBox.type = "button";
      anBox.setAttribute("role", "switch");
      anBox.setAttribute("aria-checked", st.announce !== false ? "true" : "false");
      anBox.setAttribute("aria-label", "tell Claude about custom models in the system prompt");
      anBox.disabled = !!st.announceLocked;
      if (st.announceLocked) anBox.title = "Set in claude-desktop-extra.jsonc - edit that file to change it";
      anBox.addEventListener("click", function () {
        if (anBox.disabled) return;
        anBox.disabled = true;
        var want = anBox.getAttribute("aria-checked") !== "true";
        call("customModelsAnnounceSet", want).then(function (okd) {
          if (okd) toast(want ? "New sessions are told about the custom models" : "New sessions are not told - CLAUDE.md is on its own");
          else anBox.disabled = false;
        });
      });
      anAside.appendChild(anBox);
      anRow.appendChild(anAside);
      host.appendChild(anRow);


      var files = el("div", "cdbx-note cdbx-models-files",
        "Keys are stored in " + (st.paths && st.paths.secrets) + " (0600), never in the files below. " +
        "Routing changes (a key, a model, a provider) reach open sessions at once through " + (st.paths && st.paths.routes) +
        ". New models show in the picker after the Code tab reloads. Sub-agent types, the default sub-agent " +
        "model, the small/fast model and the system-prompt line are handed to each session as it opens. A " +
        "session opened while custom models were off needs reopening.");
      host.appendChild(files);
      // Every panel ends in the files behind it, as links (see pathRow).
      if (st.paths && st.paths.json) {
        host.appendChild(pathRow("Providers and models (written by this page)", st.paths.json, cfgLocation(st.paths.json)));
      }
      if (st.paths && st.paths.jsonc) {
        host.appendChild(pathRow("Providers set by hand here are shown locked", st.paths.jsonc, cfgLocation(st.paths.jsonc)));
      }
    }

    function providerCard(p, st) {
      var card = el("div", "cdbx-models-card" + (p.locked ? " cdbx-models-locked" : ""));
      var head = el("div", "cdbx-row");
      var main = el("div", "cdbx-row-main");
      main.appendChild(el("div", "cdbx-id", p.id + (p.locked ? " - set in claude-desktop-extra.jsonc" : "")));
      main.appendChild(el("div", "cdbx-note", p.baseUrl +
        (p.native ? " - Anthropic's API on your API credit: the CLI's requests go as they are (prompt caching kept), " +
          "Claude models listed as claude-" + p.id + "-<model> next to the subscription's" : "") +
        (p.locked ? " - locked: this provider and its models are edited in that file, not here" : "")));
      var keyLine = p.keyOk
        ? "API key: " + ({ value: "in the config file", env: "from the environment", file: "from a key file", stored: "stored" })[p.keySource]
        : "API key: MISSING - sessions on these models fail until one is set";
      main.appendChild(el("div", "cdbx-state" + (p.keyOk ? "" : " cdbx-models-warn"), keyLine +
        " - effort levels " + (p.effort || []).join("/")));
      // Models skipped because even under this provider's prefix they would
      // be listed with one of Anthropic's own ids (a provider named "opus"):
      // they are not in the list below, so they are named here, with a way
      // to drop them from the file.
      if (p.shadowed && p.shadowed.length) {
        var one = p.shadowed.length === 1;
        var sh = el("div", "cdbx-note cdbx-models-warn cdbx-models-shadowed", "Skipped: " + p.shadowed.join(", ") +
          " - listed under this provider's id, " + (one ? "it" : "they") + " would still carry one of Anthropic's own " +
          "model ids and take those sessions away from your subscription. Give the provider another id" +
          (p.locked ? " in claude-desktop-extra.jsonc." : ", or remove " + (one ? "it" : "them") + "."));
        if (!p.locked) {
          var shRm = el("button", "cdbx-clear", one ? "remove it" : "remove them");
          shRm.type = "button";
          shRm.addEventListener("click", function () {
            var chain = Promise.resolve(true);
            p.shadowed.forEach(function (id) {
              chain = chain.then(function (okd) { return okd ? call("customModelsModelDelete", p.id, id) : false; });
            });
            chain.then(function (okd) { if (okd) toast("Removed " + p.shadowed.join(", ") + " from " + p.id); });
          });
          sh.appendChild(shRm);
        }
        main.appendChild(sh);
      }
      // The result of the last test, on the card itself: a toast alone is
      // gone in seconds and sits far from the button.
      var testLine = el("div", "cdbx-note cdbx-models-testline");
      testLine.hidden = true;
      main.appendChild(testLine);
      head.appendChild(main);
      var aside = el("div", "cdbx-row-aside");
      var test = el("button", "cdbx-clear", "test");
      test.type = "button";
      test.title = "Send a minimal request to the first model with the stored key";
      function showTest(text, bad) {
        testLine.textContent = text;
        testLine.className = "cdbx-note cdbx-models-testline" + (bad ? " cdbx-models-warn" : "");
        testLine.hidden = false;
        toast(text, bad);
      }
      test.addEventListener("click", function () {
        // Never a silent button: what is missing is said instead.
        if (!p.keyOk) { showTest("Provider " + p.id + ": no API key - edit the provider and paste one", true); return; }
        if (!p.models.length) { showTest("Provider " + p.id + ": add a model first (test sends a minimal request to the first model)", true); return; }
        test.disabled = true;
        test.textContent = "testing...";
        api.customModelsTest(p.id).then(function (r) {
          test.disabled = false;
          test.textContent = "test";
          if (failed(r)) showTest("Provider " + p.id + ": " + reason(r), true);
          else showTest("Provider " + p.id + " answered (" + r.model + ", HTTP " + r.status + ")");
        }, function (err) {
          test.disabled = false;
          test.textContent = "test";
          showTest("Provider " + p.id + ": " + (err && err.message ? err.message : String(err)), true);
        });
      });
      aside.appendChild(test);
      if (!p.locked) {
        var edit = el("button", "cdbx-clear", "edit");
        edit.type = "button";
        edit.addEventListener("click", function () {
          if (card.querySelector(".cdbx-models-form")) return;
          card.appendChild(providerForm(p, st));
        });
        aside.appendChild(edit);
        var del = el("button", "cdbx-clear", "remove");
        del.type = "button";
        del.title = "Removes the provider, its models and its stored key";
        // Two clicks within 15 s: long enough to read the label, short
        // enough that a stray click a minute later removes nothing.
        del.addEventListener("click", function () {
          if (!del.classList.contains("cdbx-armed")) {
            del.classList.add("cdbx-armed");
            del.textContent = "remove? click again";
            setTimeout(function () { del.classList.remove("cdbx-armed"); del.textContent = "remove"; }, 15000);
            return;
          }
          call("customModelsProviderDelete", p.id).then(function (okd) {
            if (okd) toast("Provider " + p.id + " removed");
          });
        });
        aside.appendChild(del);
      }
      head.appendChild(aside);
      card.appendChild(head);

      // models of this provider
      var list = el("div", "cdbx-list cdbx-models-list");
      if (!p.models.length) list.appendChild(el("div", "cdbx-empty", "No model yet - the provider is idle until one is added."));
      p.models.forEach(function (m) {
        var row = el("div", "cdbx-row");
        var rm = el("div", "cdbx-row-main");
        rm.appendChild(el("div", "cdbx-id", m.name + (m.name !== m.id && m.name.indexOf(m.id + " (") !== 0 ? "  (" + m.id + ")" : "")));
        var traits = [];
        traits.push("in the picker as " + (Array.isArray(m.listedAs) && m.listedAs.length ? m.listedAs.join(" and ") : m.alias));
        traits.push(m.context === "1m" ? "1M context" : m.context === "both" ? "200k and a 1M twin" : "200k context");
        traits.push(m.thinking ? "default effort " + m.effortDefault : "no thinking");
        traits.push(m.vision ? "images" : "no images");
        traits.push(m.webSearch === false ? "no web search tool" : "web search tool");
        traits.push(m.agent === false ? "no sub-agent type" : "sub-agent type " + (m.agentName || "?"));
        if (m.badge) traits.push("badge \"" + m.badge + "\"");
        rm.appendChild(el("div", "cdbx-note", traits.join(" - ")));
        row.appendChild(rm);
        if (!p.locked) {
          var ra = el("div", "cdbx-row-aside");
          var me = el("button", "cdbx-clear", "edit");
          me.type = "button";
          me.addEventListener("click", function () {
            if (row.querySelector(".cdbx-models-form")) return;
            row.appendChild(modelForm(p, m));
          });
          ra.appendChild(me);
          var md = el("button", "cdbx-clear", "remove");
          md.type = "button";
          md.addEventListener("click", function () {
            call("customModelsModelDelete", p.id, m.id).then(function (okd) {
              if (okd) toast("Model " + m.id + " removed from " + p.id);
            });
          });
          ra.appendChild(md);
          row.appendChild(ra);
        }
        list.appendChild(row);
      });
      card.appendChild(list);
      if (!p.locked) {
        var actions = el("div", "cdbx-models-actions cdbx-models-card-actions");
        // The provider's own list: tick what to add. Effort levels follow the
        // preset's knowledge when there is any; detect covers the rest.
        var fetchBtn = el("button", "cdbx-btn", "Fetch models");
        fetchBtn.type = "button";
        fetchBtn.title = "Ask the provider which models it serves";
        fetchBtn.addEventListener("click", function () {
          if (!p.keyOk) { toast("Provider " + p.id + ": no API key - edit the provider and paste one before fetching its models", true); return; }
          var old = card.querySelector(".cdbx-models-fetched");
          if (old) old.remove();
          fetchBtn.disabled = true;
          fetchBtn.textContent = "Fetching...";
          api.customModelsModelsList(p.id).then(function (r) {
            fetchBtn.disabled = false;
            fetchBtn.textContent = "Fetch models";
            if (failed(r)) { toast("Could not list models: " + reason(r), true); return; }
            card.insertBefore(fetchedList(p, r), actions);
          }, function (err) {
            fetchBtn.disabled = false;
            fetchBtn.textContent = "Fetch models";
            toast("Could not list models: " + (err && err.message ? err.message : String(err)), true);
          });
        });
        actions.appendChild(fetchBtn);
        var add = el("button", "cdbx-btn cdbx-models-add", "Add a model");
        add.type = "button";
        add.addEventListener("click", function () {
          if (card.querySelector(".cdbx-models-form-model-new")) return;
          var f = modelForm(p, null);
          f.classList.add("cdbx-models-form-model-new");
          card.insertBefore(f, actions);
        });
        actions.appendChild(add);
        card.appendChild(actions);
      }
      return card;
    }

    // The checklist of a provider's fetched models; already-configured ones
    // are shown ticked and disabled.
    function fetchedList(p, r) {
      var box = el("div", "cdbx-models-fetched");
      box.appendChild(el("div", "cdbx-note", r.models.length + " model" + (r.models.length === 1 ? "" : "s") +
        " listed by " + r.source + ". Tick the ones to add."));
      if (r.hidden && r.hidden.length) {
        box.appendChild(el("div", "cdbx-note", r.hidden.length + " not listed: " + r.infoSource +
          " says they are not chat models (" + r.hidden.slice(0, 10).map(function (x) { return x.id + ": " + x.mode; }).join(", ") +
          (r.hidden.length > 10 ? ", ..." : "") + ")."));
      }
      var have = Object.create(null);
      p.models.forEach(function (m) { have[m.id] = true; });
      var boxes = [];
      // A gateway lists hundreds: a filter narrows the checklist by id or name.
      var filter = null;
      if (r.models.length > 12) {
        filter = input("text", "", "filter (e.g. qwen, glm)");
        filter.className = "cdbx-input cdbx-models-filter";
        box.appendChild(filter);
      }
      r.models.forEach(function (m) {
        var lab = el("label", "cdbx-models-level");
        var cb = checkbox(!!have[m.id]);
        cb.disabled = !!have[m.id];
        cb.value = m.id;
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(" " + m.id + (m.name && m.name !== m.id ? " (" + m.name + ")" : "") +
          (m.context === "1m" ? " - 1M" : "") + (have[m.id] ? " - added" : "")));
        box.appendChild(lab);
        boxes.push({ cb: cb, m: m, lab: lab });
      });
      if (filter) filter.addEventListener("input", function () {
        var q = filter.value.trim().toLowerCase();
        boxes.forEach(function (b) {
          b.lab.hidden = !!q && (b.m.id + " " + (b.m.name || "")).toLowerCase().indexOf(q) === -1;
        });
      });
      var act = el("div", "cdbx-models-actions");
      var addSel = el("button", "cdbx-btn", "Add selected");
      addSel.type = "button";
      addSel.addEventListener("click", function () {
        var picked = boxes.filter(function (b) { return b.cb.checked && !b.cb.disabled; }).map(function (b) { return b.m; });
        if (!picked.length) { toast("Tick at least one model", true); return; }
        addSel.disabled = true;
        var chain = Promise.resolve(null);
        picked.forEach(function (m) {
          chain = chain.then(function () {
            var payload = { id: m.id, name: m.name && m.name !== m.id ? m.name : "" };
            if (m.context) payload.context = m.context; // the listing's context length, when it states one
            if (m.vision === false) payload.vision = false; // the gateway's model info says no images
            if (m.thinking === false) payload.thinking = false; // ... or no reasoning
            return api.customModelsModelSet(p.id, payload);
          });
        });
        chain.then(function (last) {
          if (refresh(last)) toast(picked.length + " model" + (picked.length === 1 ? "" : "s") + " added to " + p.id + offHint());
          else addSel.disabled = false;
        }, function (err) {
          addSel.disabled = false;
          toast("Could not add: " + (err && err.message ? err.message : String(err)), true);
        });
      });
      act.appendChild(addSel);
      var close = el("button", "cdbx-clear", "close");
      close.type = "button";
      close.addEventListener("click", function () { box.remove(); });
      act.appendChild(close);
      box.appendChild(act);
      return box;
    }

    function field(form, label, control, note) {
      var row = el("div", "cdbx-row cdbx-models-field");
      var main = el("div", "cdbx-row-main");
      main.appendChild(el("div", "cdbx-id", label));
      if (note) main.appendChild(el("div", "cdbx-note", note));
      row.appendChild(main);
      var aside = el("div", "cdbx-row-aside");
      aside.appendChild(control);
      row.appendChild(aside);
      form.appendChild(row);
      return control;
    }
    function input(type, value, placeholder) {
      var c = el("input", "cdbx-input");
      c.type = type;
      c.value = value || "";
      if (placeholder) c.placeholder = placeholder;
      c.autocomplete = "off";
      c.spellcheck = false;
      return c;
    }
    function checkbox(checked) {
      var c = el("input");
      c.type = "checkbox";
      c.checked = !!checked;
      return c;
    }

    // Add (existing === null) or edit a provider. The key field is write-only:
    // empty keeps whatever is stored.
    function providerForm(existing, st) {
      var form = el("div", "cdbx-models-form");
      var preset = null;
      if (!existing && st.presets && st.presets.length) {
        preset = el("select", "cdbx-select");
        var none = el("option", "", "pick a preset or fill in by hand");
        none.value = "";
        preset.appendChild(none);
        st.presets.forEach(function (pr) {
          var o = el("option", "", pr.label + " - " + pr.baseUrl);
          o.value = pr.id;
          preset.appendChild(o);
        });
        field(form, "Preset", preset, "Prefills the fields below; everything stays editable.");
      }
      var id = field(form, "Provider id", input("text", existing ? existing.id : "", "provider-id"),
        "Short name used in logs and the Settings state line. Letters, digits, - and _.");
      if (existing) id.disabled = true;
      var url = field(form, "Base URL", input("text", existing ? existing.baseUrl : "", "https://api.example.com/anthropic"),
        "The Anthropic-compatible endpoint; /v1/messages is appended.");
      var key = field(form, "API key", input("password", "", existing && existing.keyOk ? "stored - type to replace" : "API key"),
        "Stored in a 0600 file in this profile, never shown again, sent only to that endpoint.");
      var modelsUrl = field(form, "Models list URL", input("text", existing ? existing.modelsUrl || "" : "", "optional - found automatically"),
        "Where the provider lists its models (GET, OpenAI or Anthropic shape), on the base URL's host - the key " +
        "goes nowhere else. Left empty, fetch models tries the preset's address, then <base URL>/v1/models, " +
        "<origin>/v1/models and <origin>/models.");
      var userAgent = field(form, "User-Agent", input("text", existing ? existing.userAgent || "" : "", "optional - the runtime's own"),
        "Sent with every request to this endpoint: the sessions', and fetch models, test and detect here. Empty: " +
        "Claude Code's runtime default (Bun/<version>), or on Anthropic's API the CLI's own. Printable ASCII, " +
        "300 characters at most.");
      // Anthropic's API uses the billing line: not offered there.
      var stripBilling = existing && existing.native ? null
        : field(form, "Drop the billing line", checkbox(existing ? existing.stripBillingHeader : false),
          "Claude Code starts the system prompt with a line for Anthropic's billing (x-anthropic-billing-header: ... " +
          "cc_entrypoint=claude-desktop ...). On: it is left out of requests to this endpoint; the rest of the " +
          "prompt is unchanged. Ignored for Anthropic's API, which uses it.");
      // Effort: an API convention of the provider (DeepSeek: low/high/max),
      // so it is set here and every model of the provider inherits it. The
      // preset fills it when it knows; detect asks the provider (one minimal
      // request per level to its first model).
      var offered = existing && Array.isArray(existing.effort) ? existing.effort.slice() : EFFORT_LEVELS.slice();
      var levelsBox = el("div", "cdbx-models-levels");
      var levelBoxes = {};
      EFFORT_LEVELS.forEach(function (lv) {
        var lab = el("label", "cdbx-models-level");
        var cb = checkbox(offered.indexOf(lv) !== -1);
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(" " + lv));
        levelsBox.appendChild(lab);
        levelBoxes[lv] = cb;
      });
      var detect = el("button", "cdbx-clear", "detect");
      detect.type = "button";
      detect.title = "Send one minimal request with each level to this provider's first model and tick the ones it accepts";
      detect.disabled = !(existing && existing.keyOk && existing.models.length);
      if (detect.disabled) detect.title = existing ? "Needs the key and at least one model" : "Save the provider and add a model first";
      detect.addEventListener("click", function () {
        detect.disabled = true;
        detect.textContent = "detecting...";
        api.customModelsEffortProbe(existing.id, "").then(function (r) {
          detect.disabled = false;
          detect.textContent = "detect";
          if (failed(r)) { toast("Could not detect: " + reason(r), true); return; }
          EFFORT_LEVELS.forEach(function (lv) { levelBoxes[lv].checked = r.accepted.indexOf(lv) !== -1; });
          var refused = Object.keys(r.rejected || {});
          toast(existing.id + " accepts " + r.accepted.join(", ") + (refused.length ? " - refused: " + refused.join(", ") : "") + " - Save to apply");
        }, function (err) {
          detect.disabled = false;
          detect.textContent = "detect";
          toast("Could not detect: " + (err && err.message ? err.message : String(err)), true);
        });
      });
      levelsBox.appendChild(detect);
      field(form, "Effort levels", levelsBox,
        "The levels this provider's API distinguishes under the app's names - the same for all its models. " +
        "Only those appear in the picker's effort menu, sent as they are. A preset fills it in from the " +
        "provider's documentation; detect asks the provider, which tells strict APIs (a refused name is a " +
        "400) but not permissive ones that accept every name and fold the extra ones (DeepSeek does). A level " +
        "still refused at run time is dropped from that request and logged.");
      var chosenPreset = existing ? existing.preset || "" : "";
      if (preset) {
        preset.addEventListener("change", function () {
          var pr = null;
          st.presets.forEach(function (x) { if (x.id === preset.value) pr = x; });
          chosenPreset = pr ? pr.id : "";
          if (!pr) return;
          id.value = pr.id;
          url.value = pr.baseUrl;
          key.placeholder = pr.keyHint || "API key";
          modelsUrl.value = pr.modelsUrl || "";
          var lv = pr.effort || EFFORT_LEVELS;
          EFFORT_LEVELS.forEach(function (l) { levelBoxes[l].checked = lv.indexOf(l) !== -1; });
        });
      }
      var actions = el("div", "cdbx-models-actions");
      var save = el("button", "cdbx-btn", existing ? "Save" : "Add provider");
      save.type = "button";
      save.addEventListener("click", function () {
        save.disabled = true;
        var payload = { id: id.value, baseUrl: url.value, apiKey: key.value, preset: chosenPreset, modelsUrl: modelsUrl.value,
          userAgent: userAgent.value, effort: EFFORT_LEVELS.filter(function (lv) { return levelBoxes[lv].checked; }) };
        if (stripBilling) payload.stripBillingHeader = stripBilling.checked;
        api.customModelsProviderSet(payload).then(function (r) {
          if (failed(r)) { save.disabled = false; toast("Could not save: " + reason(r), true); return; }
          refresh(r);
          if (r.keyCleared || r.headersCleared) {
            toast("Provider " + existing.id + " saved - its base URL moved to another host, so " +
              (r.keyCleared && r.headersCleared ? "the stored key and the custom headers were" : r.keyCleared ? "the stored key was" : "the custom headers were") +
              " cleared" + (r.keyCleared ? ": paste the key again" : " (add them again in the config file)"), true);
          }
          else toast(existing ? "Provider " + existing.id + " saved"
            : "Provider " + payload.id.trim() + " added - fetch models on its card, or add one by hand");
        }, function (err) {
          save.disabled = false;
          toast("Could not save: " + (err && err.message ? err.message : String(err)), true);
        });
      });
      actions.appendChild(save);
      var cancel = el("button", "cdbx-clear", "cancel");
      cancel.type = "button";
      cancel.addEventListener("click", function () { form.remove(); });
      actions.appendChild(cancel);
      form.appendChild(actions);
      return form;
    }

    // Add (existing === null) or edit a model of provider p.
    function modelForm(p, existing) {
      var form = el("div", "cdbx-models-form");
      var id = field(form, "Model id", input("text", existing ? existing.id : "", "model-id"),
        "The provider's own id. The app and the CLI see it as claude-<id>.");
      if (existing) id.disabled = true;
      var name = field(form, "Display name", input("text", existing ? (existing.name !== existing.id ? existing.name : "") : "", "Display name"),
        "What the picker shows.");
      var desc = field(form, "Description", input("text", existing ? existing.description : "", "optional subtitle"),
        "Optional line under the name. Anthropic's own entries have none.");
      var thinking = field(form, "Thinking", checkbox(existing ? existing.thinking : true),
        "Off: no effort menu, thinking never requested.");
      // The provider's levels; the default is chosen among them.
      var avail = Array.isArray(p.effort) && p.effort.length ? p.effort : EFFORT_LEVELS;
      var effort = el("select", "cdbx-select");
      avail.forEach(function (lv) {
        var o = el("option", "", lv);
        o.value = lv;
        effort.appendChild(o);
      });
      var want = existing && existing.effortDefault ? existing.effortDefault : "xhigh";
      if (avail.indexOf(want) === -1) want = avail.indexOf("xhigh") !== -1 ? "xhigh" : avail[avail.length - 1];
      effort.value = want;
      field(form, "Default effort", effort, "The level marked as the default in the picker's effort menu, among the provider's " +
        "levels (" + avail.join(", ") + "). It applies when the model is picked and the session's current level is not one " +
        "this model offers; a level it does offer is kept across the switch, the way the app does for its own models.");
      var vision = field(form, "Images", checkbox(existing ? existing.vision : true),
        "Off: images are replaced by a placeholder line before the request leaves.");
      var webSearch = field(form, "Web search tool", checkbox(existing ? existing.webSearch !== false : true),
        "Whether the provider's API runs Anthropic's server-side web_search tool for this model (DeepSeek's " +
        "/anthropic API does). Off: that tool is stripped from its requests and the model is not offered as the " +
        "web-search model above. The model can still search through Claude Code's own WebSearch tool - that " +
        "search then runs where the Web search setting says, Anthropic by default.");
      // The CLI trusts only the id for a model's context window: 200k for
      // anything it does not know, 1M when the id ends in [1m]. The window
      // drives the context gauge and auto-compaction.
      var inheritedContext = p.context === "200k" || p.context === "both" ? p.context : "1m";
      var context = el("select", "cdbx-select");
      [["200k", "200k - listed as claude-<id>"],
       ["1m", "1M - listed as claude-<id>[1m], under its plain name"],
       ["both", "both - two entries, \"<name>\" and \"<name> 1M\", like Sonnet and Opus"]].forEach(function (c) {
        var o = el("option", "", c[1]);
        o.value = c[0];
        context.appendChild(o);
      });
      context.value = existing && existing.context ? existing.context : inheritedContext;
      field(form, "Context window", context,
        "What Claude Code believes the model's window is - it reads only the id: 200k for a model it does not " +
        "know, 1M when the id ends in [1m]. It sets the context gauge and when the session auto-compacts, so a " +
        "natively-1M model left on 200k is compacted at 200k. \"both\" is for a provider that prices the two windows " +
        "differently. The provider receives the bare id either way." +
        (presetContext(p, lastState) ? " Preset default: " + inheritedContext + "." : " Default here: " + inheritedContext + "."));
      var badge = field(form, "Badge", input("text", existing ? existing.badge : "", "optional, e.g. beta"),
        "Optional neutral badge next to the name.");
      // The sub-agent type: handed to the CLI with every new session, so
      // Claude launches this model by name. The texts default to generated
      // ones; the description is what Claude reads to decide when to use it.
      var defaults = existing && existing.agentDefaults ? existing.agentDefaults : { name: "", description: "", prompt: "" };
      var agent = field(form, "Sub-agent type", checkbox(existing ? existing.agent !== false : true),
        "Expose the model as a sub-agent type Claude can launch by name (Agent tool subagent_type, workflow agentType). " +
        "Read when a session opens.");
      var agentName = field(form, "Sub-agent name", input("text", existing ? existing.agentName && existing.agentName !== defaults.name ? existing.agentName : "" : "", defaults.name || "generated from the display name"),
        "Lowercase letters, digits and - (40 max). Empty: generated from the display name.");
      var agentDesc = field(form, "Sub-agent description", input("text", existing ? existing.agentDescription : "", "generated"),
        "What Claude reads to decide when to launch it - a role and its limits, in your words. Empty: a generic line." +
        (defaults.description ? " Generated: \"" + defaults.description + "\"" : ""));
      var agentPrompt = el("textarea", "cdbx-area cdbx-models-agent-prompt");
      agentPrompt.value = existing ? existing.agentPrompt || "" : "";
      agentPrompt.placeholder = "generated";
      agentPrompt.spellcheck = false;
      field(form, "Sub-agent prompt", agentPrompt,
        "Its system prompt. Empty: a generic one." + (defaults.prompt ? " Generated: \"" + defaults.prompt + "\"" : ""));
      var actions = el("div", "cdbx-models-actions");
      var save = el("button", "cdbx-btn", existing ? "Save" : "Add model");
      save.type = "button";
      save.addEventListener("click", function () {
        save.disabled = true;
        var payload = { id: id.value, name: name.value, description: desc.value, badge: badge.value,
          thinking: thinking.checked, vision: vision.checked, webSearch: webSearch.checked,
          context: context.value, effortDefault: effort.value,
          agent: agent.checked, agentName: agentName.value, agentDescription: agentDesc.value, agentPrompt: agentPrompt.value };
        call("customModelsModelSet", p.id, payload).then(function (okd) {
          if (!okd) save.disabled = false;
          else toast(existing ? "Model " + existing.id + " saved" : "Model " + payload.id.trim() + " added to " + p.id + offHint());
        });
      });
      actions.appendChild(save);
      var cancel = el("button", "cdbx-clear", "cancel");
      cancel.type = "button";
      cancel.addEventListener("click", function () { form.remove(); });
      actions.appendChild(cancel);
      form.appendChild(actions);
      return form;
    }

    draw(state);
  }

  // --- anthropic features panel --------------------------------------------
  // Anthropic's own GrowthBook flags. Nothing here applies live: the app reads
  // most of them once at startup, so this panel carries the restart notice the
  // Community Features panel does not need.

  function renderFlags(panel) {
    clear(panel);
    panel.appendChild(el("div", "cdbx-h1", "Anthropic Features"));

    panel.appendChild(el("div", "cdbx-sub",
      "Anthropic's GrowthBook feature flags, as observed being read by this build. " +
      "Flags already on for your account are switched on below; turning one off writes an explicit override."));

    var notice = el("div", "cdbx-notice");
    notice.appendChild(el("div", "cdbx-notice-title", "Changes here require a restart of Claude Desktop"));
    notice.appendChild(el("div", "cdbx-notice-body",
      "Overrides are saved immediately, but most flags are read once at startup. " +
      "Quitting Claude Desktop and reopening it from your desktop launcher is the cleanest way: " +
      "\"Restart now\" relaunches the app directly and so skips the launcher's systemd scope and environment."));
    var restart = restartButton();
    notice.appendChild(restart);
    panel.appendChild(notice);

    var status = el("div", "cdbx-empty", "Loading flags...");
    panel.appendChild(status);

    Promise.all([api.flagsCatalog(), api.flagsRead()]).then(function (both) {
      var catalog = both[0];
      var state = both[1];
      if (failed(catalog)) {
        status.className = "cdbx-error";
        status.textContent = "The flag catalog is unavailable: " + reason(catalog);
        return;
      }
      if (failed(state)) {
        status.className = "cdbx-error";
        status.textContent = "Flag state is unavailable: " + reason(state);
        return;
      }
      status.remove();

      var search = el("input", "cdbx-search");
      search.type = "search";
      search.placeholder = "Filter " + catalog.entries.length + " flags by id or description";
      panel.appendChild(search);
      focusFilter(search);

      var list = el("div", "cdbx-list");
      panel.appendChild(list);

      // Only the .jsonc is linked. It is the config file of this package - the one
      // a human edits, with the commented flag catalog in it, and whose flag ids
      // win over this page. The .json next to it is where the switches are
      // persisted, but that is internal bookkeeping: it exists so this page never
      // has to rewrite the commented file, and it is not a file to send anyone to.
      var paths = state.paths || {};
      if (paths.jsonc) {
        panel.appendChild(pathRow("Flags you set by hand here win over this page",
          paths.jsonc, cfgLocation(paths.jsonc)));
      }
      if (!state.storeSeen) {
        panel.appendChild(el("div", "cdbx-path",
          "The feature store has not loaded yet in this session, so the switches below show your saved overrides only."));
      }

      var server = state.server || {};
      var effective = state.effective || {};
      var overrides = state.overridesJson || {};
      var jsoncIds = state.overridesJsonc || {};
      var builtins = state.builtins || {};

      // Pre-toggle state: what the app is actually going to see. The effective
      // map is the server payload with every override already merged, so it is
      // the truth when the store has loaded; before that, fall back to the saved
      // override files.
      function isOn(id) {
        var entry = effective[id] || server[id];
        if (entry) return entry.on === true;
        if (Object.prototype.hasOwnProperty.call(jsoncIds, id)) return jsoncIds[id] === true;
        if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] === true;
        if (Object.prototype.hasOwnProperty.call(builtins, id)) return builtins[id] === true;
        return false;
      }

      function origin(id) {
        if (Object.prototype.hasOwnProperty.call(jsoncIds, id)) return "set in claude-desktop-extra.jsonc";
        if (Object.prototype.hasOwnProperty.call(overrides, id)) return "your override (" + JSON.stringify(overrides[id]) + ")";
        if (Object.prototype.hasOwnProperty.call(builtins, id)) return "forced on by claude-desktop-extra for Linux";
        var entry = server[id];
        if (entry) return entry.on === true ? "on for your account" : "off for your account";
        return "not in your account's flag payload";
      }

      function row(entry) {
        var id = entry.id;
        var node = el("div", "cdbx-row");
        var main = el("div", "cdbx-row-main");
        main.appendChild(el("div", "cdbx-id", id));
        if (entry.note) main.appendChild(el("div", "cdbx-note" + (entry.warn ? " cdbx-warn" : ""), entry.note));
        var stateLine = el("div", "cdbx-state", origin(id));
        main.appendChild(stateLine);
        node.appendChild(main);

        var aside = el("div", "cdbx-row-aside");
        node.appendChild(aside);

        function flash() {
          node.classList.add("cdbx-flash");
          setTimeout(function () { node.classList.remove("cdbx-flash"); }, 700);
        }

        // Value-carrying flags are never switches: a bare true would replace a
        // server-provided number/string/object with something meaningless.
        if (entry.valueFlag) {
          var current = effective[id] || server[id];
          var text = current && current.value !== undefined
            ? JSON.stringify(current.value)
            : "not set";
          var chip = el("div", "cdbx-value", text);
          chip.title = text;
          aside.appendChild(chip);
          stateLine.textContent = origin(id) + " - value flag, read-only here";
          return node;
        }

        var lockedJsonc = Object.prototype.hasOwnProperty.call(jsoncIds, id);
        var toggle = el("button", "cdbx-switch");
        toggle.type = "button";
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-checked", isOn(id) ? "true" : "false");
        toggle.setAttribute("aria-label", "feature flag " + id);

        if (entry.warn) {
          toggle.disabled = true;
          toggle.title = entry.note;
          stateLine.textContent = origin(id) + " - locked by claude-desktop-extra";
        } else if (lockedJsonc) {
          toggle.disabled = true;
          toggle.title = "Edit claude-desktop-extra.jsonc to change this flag";
        }

        var clearBtn = null;
        function syncClear() {
          var has = Object.prototype.hasOwnProperty.call(overrides, id);
          if (has && !clearBtn) {
            clearBtn = el("button", "cdbx-clear", "clear");
            clearBtn.type = "button";
            clearBtn.title = "Remove this override and follow your account again";
            clearBtn.addEventListener("click", function () {
              api.flagsUnset(id).then(function (res) {
                if (failed(res)) { toast("Could not clear " + id + ": " + reason(res), true); return; }
                delete overrides[id];
                if (effective[id]) delete effective[id];
                toggle.setAttribute("aria-checked", isOn(id) ? "true" : "false");
                stateLine.textContent = origin(id);
                syncClear();
                flash();
                toast("Cleared the override for " + id + " - restart to pick it up");
              }, function (err) {
                toast("Could not clear " + id + ": " + (err && err.message ? err.message : String(err)), true);
              });
            });
            aside.insertBefore(clearBtn, toggle);
          } else if (!has && clearBtn) {
            clearBtn.remove();
            clearBtn = null;
          }
        }

        toggle.addEventListener("click", function () {
          if (toggle.disabled) return;
          var next = toggle.getAttribute("aria-checked") !== "true";
          toggle.disabled = true;
          api.flagsSet(id, next).then(function (res) {
            toggle.disabled = false;
            if (failed(res)) { toast("Could not save " + id + ": " + reason(res), true); return; }
            overrides[id] = next;
            effective[id] = { on: next, value: next };
            toggle.setAttribute("aria-checked", next ? "true" : "false");
            stateLine.textContent = origin(id);
            syncClear();
            flash();
            toast(id + " set to " + next + " - saved, restart to pick it up");
          }, function (err) {
            toggle.disabled = false;
            toast("Could not save " + id + ": " + (err && err.message ? err.message : String(err)), true);
          });
        });

        aside.appendChild(toggle);
        syncClear();
        return node;
      }

      // Built-in Linux forces that are not in the catalog still deserve a row -
      // they are flags this package changes for you.
      var entries = catalog.entries.slice();
      var known = {};
      entries.forEach(function (entry) { known[entry.id] = 1; });
      Object.keys(builtins).forEach(function (id) {
        if (known[id]) return;
        entries.push({ id: id, note: "forced on by claude-desktop-extra on Linux", valueFlag: false, warn: "" });
      });

      function draw(filter) {
        clear(list);
        var needle = (filter || "").trim().toLowerCase();
        var shown = 0;
        entries.forEach(function (entry) {
          if (needle && entry.id.indexOf(needle) < 0 &&
              (entry.note || "").toLowerCase().indexOf(needle) < 0) return;
          shown++;
          list.appendChild(row(entry));
        });
        if (!shown) list.appendChild(el("div", "cdbx-empty", "No flag matches that filter."));
      }

      search.addEventListener("input", function () { draw(search.value); });
      draw("");
    }, function (err) {
      status.className = "cdbx-error";
      status.textContent = "Flags are unavailable: " + (err && err.message ? err.message : String(err));
    });
  }

  // --- deployment panel ----------------------------------------------------
  //
  // 1P/3P is decided in the bootstrap before any window exists, so nothing here
  // takes effect before a full restart - the panel says so, and offers the
  // restart. Every write goes to files inside THIS profile's own config dir:
  // <userData>-3p/claude_desktop_config.json for the mode, and the applied entry
  // of <userData>-3p/configLibrary for the configuration. The main half explains
  // the precedence; what matters here is that a machine that got stuck in 3P can
  // be switched back with one click, and that the values the app boots from are
  // editable without root.

  var MODE_NAME = { "1p": "Personal - claude.ai account", "3p": "Third-party inference" };
  var MODE_SHORT = { "1p": "1P", "3p": "3P" };

  function modeName(mode) {
    return MODE_NAME[mode] || "unknown";
  }

  // A stored secret is never sent to this page: the row shows that one exists and
  // typing a new value replaces it.
  function isSet(value) {
    return value !== undefined && value !== null && !(Array.isArray(value) && !value.length);
  }

  function showValue(entry, value) {
    if (!isSet(value)) return "";
    if (entry.kind === "lines" || entry.kind === "models") {
      // A model entry may be an object ({ name, labelOverride, ... }); show it as
      // one JSON line so it survives an edit and parses back on save.
      return (Array.isArray(value) ? value : [value]).map(function (v) {
        if (v !== null && typeof v === "object") {
          try { return JSON.stringify(v); } catch (e) { return String(v); }
        }
        return String(v);
      }).join("\n");
    }
    if (entry.kind === "json") {
      try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
    }
    return String(value);
  }

  function renderDeploy(panel) {
    clear(panel);
    panel.appendChild(el("div", "cdbx-h1", "Deployment"));
    panel.appendChild(el("div", "cdbx-sub",
      "Personal claude.ai (1P) or your own inference backend (3P) - Bedrock, Vertex AI, Azure AI Foundry " +
      "or any Anthropic-compatible gateway. Both the switch and the values below are written to this " +
      "profile's own config directory, so no root and no enterprise policy file is needed."));

    if (!api || typeof api.deployRead !== "function") {
      panel.appendChild(el("div", "cdbx-error",
        "This build's preload does not expose the deployment bridge - reinstall to pick it up."));
      return;
    }

    var status = el("div", "cdbx-empty", "Reading the deployment configuration...");
    panel.appendChild(status);

    api.deployRead().then(function (state) {
      if (failed(state)) {
        status.className = "cdbx-error";
        status.textContent = "The deployment configuration is unavailable: " + reason(state);
        return;
      }
      status.remove();
      drawDeploy(panel, state);
    }, function (err) {
      status.className = "cdbx-error";
      status.textContent = "The deployment configuration is unavailable: " +
        (err && err.message ? err.message : String(err));
    });
  }

  function drawDeploy(panel, state) {
    var values = (state.local && state.local.values) || {};
    var expected = state.expected;

    // --- mode card ---------------------------------------------------------
    var card = el("div", "cdbx-mode");
    var live = el("div", "cdbx-mode-live");
    live.appendChild(el("div", "cdbx-mode-now", "Running now: " + modeName(state.running)));
    live.appendChild(el("div", "cdbx-mode-path", state.paths.userData));
    card.appendChild(live);

    // Undoing the mode choice itself: the same "clear" the Anthropic Features panel offers
    // for a flag override, and the same value upstream's own setDeploymentMode
    // takes. Without it, one click on 1P or 3P is permanent - the key stays in
    // the file forever and keeps overriding the stored configuration.
    var modeClear = el("button", "cdbx-clear", "clear");
    modeClear.type = "button";
    modeClear.title = "Forget the saved choice and let the stored configuration decide again";
    card.appendChild(modeClear);

    var seg = el("div", "cdbx-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "deployment mode");
    var segButtons = {};
    ["1p", "3p"].forEach(function (mode) {
      var b = el("button", "cdbx-seg-b", MODE_SHORT[mode]);
      b.type = "button";
      b.title = modeName(mode);
      b.setAttribute("aria-pressed", expected === mode ? "true" : "false");
      seg.appendChild(b);
      segButtons[mode] = b;
    });
    card.appendChild(seg);
    panel.appendChild(card);

    var nextLine = el("div", "cdbx-state");
    panel.appendChild(nextLine);

    // The restart bar: shown only while the persisted choice and the running
    // session disagree, which is the only moment it means anything.
    var notice = el("div", "cdbx-notice cdbx-info cdbx-hide");
    notice.appendChild(el("div", "cdbx-notice-title", "Restart Claude Desktop to switch"));
    notice.appendChild(el("div", "cdbx-notice-body",
      "The mode is chosen at startup, before any window exists. Quitting and reopening from your " +
      "desktop launcher is the cleanest way: \"Restart now\" relaunches the app directly and so skips " +
      "the launcher's systemd scope and environment."));
    var restart = restartButton();
    notice.appendChild(restart);
    panel.appendChild(notice);

    function syncMode() {
      Object.keys(segButtons).forEach(function (mode) {
        segButtons[mode].setAttribute("aria-pressed", expected === mode ? "true" : "false");
      });
      var from = state.source === "managed" ? "the managed policy file"
        : state.source === "local" ? "the stored configuration"
        : "no stored configuration";
      nextLine.textContent = "Next start: " + modeName(expected) + " - decided from " + from +
        (state.persisted ? " and the saved deploymentMode \"" + state.persisted + "\"" : "");
      if (expected === state.running) notice.classList.add("cdbx-hide");
      else notice.classList.remove("cdbx-hide");
      // Nothing saved, nothing to clear - and with an enterprise policy forcing
      // 3P the key would not be read anyway.
      if (state.persisted && !state.locksSignIn) modeClear.classList.remove("cdbx-hide");
      else modeClear.classList.add("cdbx-hide");
    }
    syncMode();

    modeClear.addEventListener("click", function () {
      modeClear.disabled = true;
      api.deployMode("clear").then(function (res) {
        modeClear.disabled = false;
        if (failed(res)) { toast("Could not clear the saved mode: " + reason(res), true); return; }
        state.persisted = null;
        expected = res.expected || expected;
        syncMode();
        toast("The saved mode choice is gone - the stored configuration decides again");
      }, function (err) {
        modeClear.disabled = false;
        toast("Could not clear the saved mode: " +
          (err && err.message ? err.message : String(err)), true);
      });
    });

    Object.keys(segButtons).forEach(function (mode) {
      segButtons[mode].addEventListener("click", function () {
        if (expected === mode) return;
        segButtons[mode].disabled = true;
        api.deployMode(mode).then(function (res) {
          segButtons[mode].disabled = false;
          if (failed(res)) { toast(reason(res), true); return; }
          expected = res.expected || mode;
          state.persisted = mode;
          syncMode();
          toast(expected === state.running
            ? "Back to " + modeName(expected) + " - no restart needed"
            : modeName(expected) + " selected - restart to switch");
        }, function (err) {
          segButtons[mode].disabled = false;
          toast("Could not switch mode: " + (err && err.message ? err.message : String(err)), true);
        });
      });
    });

    // --- where the configuration comes from --------------------------------
    var managed = state.managed || {};
    if (managed.present && managed.usable) {
      var box = el("div", "cdbx-notice cdbx-info");
      box.appendChild(el("div", "cdbx-notice-title", "A managed policy file is active"));
      box.appendChild(el("div", "cdbx-notice-body",
        state.paths.etcFile + " is valid and replaces the local configuration entirely" +
        (managed.provider ? " (provider: " + managed.provider + ")" : "") + ". " +
        (managed.locksSignIn
          ? "It also disables claude.ai sign-in, so this machine cannot be switched to 1P."
          : "You can still switch to 1P above; the values below are read-only while it is in place.")));
      panel.appendChild(box);
    } else if (managed.present) {
      var warn = el("div", "cdbx-notice");
      warn.appendChild(el("div", "cdbx-notice-title", "The managed policy file is being ignored"));
      warn.appendChild(el("div", "cdbx-notice-body",
        state.paths.etcFile + " " + (managed.error || "could not be read") +
        ". The local configuration below is used instead."));
      panel.appendChild(warn);
    }

    // The stored configurations upstream's own 3P Setup keeps. Applying none is
    // the non-destructive way out of 3P: every entry file stays on disk.
    var entries = (state.local && state.local.entries) || [];
    if (entries.length) {
      var pick = el("div", "cdbx-row");
      var pickMain = el("div", "cdbx-row-main");
      pickMain.appendChild(el("div", "cdbx-label", "Active configuration"));
      pickMain.appendChild(el("div", "cdbx-note",
        "The stored third-party configurations of this profile. \"None\" leaves them on disk and boots 1P."));
      pick.appendChild(pickMain);
      var pickAside = el("div", "cdbx-row-aside");
      var select = el("select", "cdbx-select");
      var none = el("option", "", "None");
      none.value = "";
      select.appendChild(none);
      entries.forEach(function (e) {
        var opt = el("option", "", (e.name || "unnamed") + " (" + e.id.slice(0, 8) + ")");
        opt.value = e.id;
        select.appendChild(opt);
      });
      select.value = state.local.appliedId || "";
      select.addEventListener("change", function () {
        select.disabled = true;
        api.deployApply(select.value).then(function (res) {
          select.disabled = false;
          if (failed(res)) {
            select.value = state.local.appliedId || "";
            toast("Could not change the active configuration: " + reason(res), true);
            return;
          }
          toast("Active configuration changed - reloading the panel");
          renderDeploy(panel);
        }, function (err) {
          select.disabled = false;
          toast("Could not change the active configuration: " +
            (err && err.message ? err.message : String(err)), true);
        });
      });
      pickAside.appendChild(select);
      pick.appendChild(pickAside);
      var pickHost = el("div", "cdbx-list");
      pickHost.appendChild(pick);
      panel.appendChild(pickHost);
    }

    // --- the key editor ----------------------------------------------------
    var head = el("div", "cdbx-sec-h");
    head.appendChild(el("span", "cdbx-sec-t", "Third-party configuration"));
    var setCount = el("span", "cdbx-sec-n", "0");
    head.appendChild(setCount);

    // The batch undo. Per-key chips only exist on keys that ARE set, so without
    // this there is no way back from a handful of accidental toggles other than
    // finding each one again. Two clicks, because it does throw away real work.
    var clearAll = el("button", "cdbx-clear cdbx-sec-act", "clear all");
    clearAll.type = "button";
    clearAll.title = "Remove every key from this configuration - the file and its name stay";
    var armed = null;
    function disarm() {
      if (armed) { clearTimeout(armed); armed = null; }
      clearAll.textContent = "clear all";
      clearAll.classList.remove("cdbx-armed");
    }
    function syncSetCount() {
      var n = Object.keys(values).length;
      setCount.textContent = String(n) + " set";
      if (n && state.editable) clearAll.classList.remove("cdbx-hide");
      else { clearAll.classList.add("cdbx-hide"); disarm(); }
    }
    clearAll.addEventListener("click", function () {
      if (!armed) {
        clearAll.textContent = "click again to clear " + Object.keys(values).length + " keys";
        clearAll.classList.add("cdbx-armed");
        armed = setTimeout(disarm, 5000);
        return;
      }
      disarm();
      clearAll.disabled = true;
      api.deployClear().then(function (res) {
        clearAll.disabled = false;
        if (failed(res)) { toast("Nothing was cleared: " + reason(res), true); return; }
        toast(res.cleared
          ? "Cleared " + res.cleared + " key(s) - the configuration is empty again"
          : "There was nothing to clear");
        renderDeploy(panel);
      }, function (err) {
        clearAll.disabled = false;
        toast("Nothing was cleared: " + (err && err.message ? err.message : String(err)), true);
      });
    });
    head.appendChild(clearAll);
    panel.appendChild(head);
    panel.appendChild(el("div", "cdbx-sub",
      "The keys of the managed-settings schema this build accepts (Claude Desktop " +
      "v1.24012.9). A key you leave untouched is simply absent from the file, and Claude Desktop " +
      "then uses its own default. Values are saved as you change them; the app reads them at startup."));

    var tools = el("div", "cdbx-tools");
    var search = el("input", "cdbx-search cdbx-search-inline");
    search.type = "search";
    search.placeholder = "Filter keys";
    tools.appendChild(search);
    focusFilter(search);
    var allBox = el("label", "cdbx-check");
    var allInput = el("input");
    allInput.type = "checkbox";
    allBox.appendChild(allInput);
    allBox.appendChild(el("span", "", "Show keys for every provider"));
    tools.appendChild(allBox);
    panel.appendChild(tools);

    var host = el("div", "cdbx-sections");
    panel.appendChild(host);

    var readOnly = !state.editable;

    function currentProvider() {
      return values.inferenceProvider || (managed.usable ? managed.provider : null);
    }

    function rowNote(entry, value) {
      if (entry.lock) return "read-only: " + entry.lock;
      if (readOnly) return "read-only while the managed policy file is active";
      if (isSet(value)) {
        if (entry.kind === "secret") return "stored - type a new value to replace it";
        return "set in this configuration";
      }
      var bits = ["not set"];
      if (entry.dflt !== undefined) bits.push("Claude Desktop default: " + JSON.stringify(entry.dflt));
      return bits.join(" - ");
    }

    // One row per key. Every control commits through the same save(), so the
    // state line, the clear chip and the restart bar stay in sync however the
    // value was edited.
    function keyRow(entry) {
      var value = values[entry.key];
      var node = el("div", "cdbx-row");
      var main = el("div", "cdbx-row-main");
      var head2 = el("div", "cdbx-label");
      head2.appendChild(el("span", "", entry.label));
      if (entry.scope === "3p") head2.appendChild(el("span", "cdbx-tag", "3P"));
      else if (entry.scope === "1p") head2.appendChild(el("span", "cdbx-tag", "1P"));
      else head2.appendChild(el("span", "cdbx-tag", "1P + 3P"));
      main.appendChild(head2);
      main.appendChild(el("div", "cdbx-id", entry.key));
      if (entry.note) main.appendChild(el("div", "cdbx-note", entry.note));
      var stateLine = el("div", "cdbx-state", rowNote(entry, value));
      main.appendChild(stateLine);
      node.appendChild(main);

      var aside = el("div", "cdbx-row-aside");
      node.appendChild(aside);

      var clearBtn = null;
      var control = null;

      function flash() {
        node.classList.add("cdbx-flash");
        setTimeout(function () { node.classList.remove("cdbx-flash"); }, 700);
      }

      function syncClear() {
        var has = isSet(values[entry.key]);
        if (has && !clearBtn && !readOnly && !entry.lock) {
          clearBtn = el("button", "cdbx-clear", "clear");
          clearBtn.type = "button";
          clearBtn.title = "Remove this key from the configuration file";
          clearBtn.addEventListener("click", function () { save(null); });
          aside.insertBefore(clearBtn, aside.firstChild);
        } else if ((!has || readOnly) && clearBtn) {
          clearBtn.remove();
          clearBtn = null;
        }
      }

      function save(next) {
        if (readOnly || entry.lock) return;
        api.deploySet(entry.key, next).then(function (res) {
          if (failed(res)) {
            toast("Could not save " + entry.key + ": " + reason(res), true);
            paint();
            return;
          }
          if (res.unchanged) return;
          if (res.value === null || res.value === undefined) delete values[entry.key];
          else values[entry.key] = res.value;
          if (res.expected) { expected = res.expected; state.persisted = res.persisted; syncMode(); }
          if (res.source) state.source = res.source;
          paint();
          syncClear();
          syncSetCount();
          flash();
          // Only the provider changes which rows belong on screen; redrawing on
          // every other save would tear down the row being edited.
          if (entry.key === "inferenceProvider") draw(search.value);
          toast(entry.key + (isSet(values[entry.key]) ? " saved" : " removed") + " - restart to apply");
        }, function (err) {
          toast("Could not save " + entry.key + ": " +
            (err && err.message ? err.message : String(err)), true);
        });
      }

      // Repaint a control from `values` after a rejected write.
      function paint() {
        var v = values[entry.key];
        stateLine.textContent = rowNote(entry, v);
        if (!control) return;
        if (entry.kind === "bool") control.setAttribute("aria-checked", v === true ? "true" : "false");
        else if (entry.kind === "secret") {
          // The field itself never holds the credential; only the placeholder
          // says whether one is stored, so it has to follow.
          control.value = "";
          control.placeholder = isSet(v) ? "stored - type to replace" : "not set";
        } else control.value = showValue(entry, v);
      }

      if (entry.kind === "bool") {
        control = el("button", "cdbx-switch");
        control.type = "button";
        control.setAttribute("role", "switch");
        control.setAttribute("aria-checked", value === true ? "true" : "false");
        control.setAttribute("aria-label", entry.key);
        control.disabled = readOnly || !!entry.lock;
        control.addEventListener("click", function () {
          if (control.disabled) return;
          save(control.getAttribute("aria-checked") !== "true");
        });
        aside.appendChild(control);
      } else if (entry.kind === "enum") {
        control = el("select", "cdbx-select");
        var empty = el("option", "", "not set");
        empty.value = "";
        control.appendChild(empty);
        entry.options.forEach(function (o) {
          var opt = el("option", "", o);
          opt.value = o;
          control.appendChild(opt);
        });
        control.value = isSet(value) ? String(value) : "";
        control.disabled = readOnly || !!entry.lock;
        control.addEventListener("change", function () { save(control.value || null); });
        aside.appendChild(control);
      } else if (entry.kind === "lines" || entry.kind === "models" || entry.kind === "json") {
        control = el("textarea", "cdbx-area");
        control.rows = entry.kind === "json" ? 4 : 3;
        control.spellcheck = false;
        control.value = showValue(entry, value);
        control.placeholder = entry.kind === "json" ? "{ }" : "one entry per line";
        control.disabled = readOnly || !!entry.lock;
        var saveBtn = el("button", "cdbx-clear", "save");
        saveBtn.type = "button";
        saveBtn.disabled = true;
        control.addEventListener("input", function () {
          saveBtn.disabled = control.value === showValue(entry, values[entry.key]);
        });
        saveBtn.addEventListener("click", function () {
          saveBtn.disabled = true;
          save(control.value.trim() ? control.value : null);
        });
        var wrap = el("div", "cdbx-areawrap");
        wrap.appendChild(control);
        if (!readOnly && !entry.lock) wrap.appendChild(saveBtn);
        node.appendChild(wrap);
        node.classList.add("cdbx-row-wide");
      } else {
        control = el("input", "cdbx-input");
        control.type = entry.kind === "secret" ? "password"
          : (entry.kind === "int" || entry.kind === "num" ? "number" : "text");
        if (entry.kind === "num") control.step = "any";
        if (entry.kind === "secret") {
          control.value = "";
          control.placeholder = isSet(value) ? "stored - type to replace" : "not set";
          control.autocomplete = "off";
        } else {
          control.value = showValue(entry, value);
          control.placeholder = entry.dflt !== undefined ? String(entry.dflt) : "not set";
        }
        control.disabled = readOnly || !!entry.lock;
        var commit = function () {
          var raw = control.value.trim();
          if (entry.kind === "secret") {
            if (!raw) return;                       // empty means "keep it"
            save(raw);
            control.value = "";
            return;
          }
          if (raw === showValue(entry, values[entry.key])) return;
          save(raw || null);
        };
        control.addEventListener("blur", commit);
        control.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        });
        aside.appendChild(control);
      }

      syncClear();
      return node;
    }

    // Provider-specific keys stay out of the way until they apply, which is what
    // keeps a gateway setup from scrolling past thirty Bedrock and Vertex fields.
    function visible(entry, needle) {
      if (needle) {
        return entry.key.toLowerCase().indexOf(needle) >= 0 ||
          entry.label.toLowerCase().indexOf(needle) >= 0 ||
          (entry.note || "").toLowerCase().indexOf(needle) >= 0;
      }
      if (!entry.only) return true;
      if (allInput.checked) return true;
      if (isSet(values[entry.key])) return true;
      return entry.only === currentProvider();
    }

    function draw(filter) {
      clear(host);
      var needle = (filter || "").trim().toLowerCase();
      var shown = 0;
      state.groups.forEach(function (group) {
        var rows = state.keys.filter(function (entry) {
          return entry.group === group.key && visible(entry, needle);
        });
        if (!rows.length) return;
        var h = el("div", "cdbx-sec-h");
        h.appendChild(el("span", "cdbx-sec-t", group.label));
        h.appendChild(el("span", "cdbx-sec-n", String(rows.length)));
        host.appendChild(h);
        var list = el("div", "cdbx-list");
        rows.forEach(function (entry) { list.appendChild(keyRow(entry)); });
        host.appendChild(list);
        shown += rows.length;
      });
      if (!shown) host.appendChild(el("div", "cdbx-empty", "No configuration key matches that filter."));
    }

    search.addEventListener("input", function () { draw(search.value); });
    allInput.addEventListener("change", function () { draw(search.value); });
    draw("");
    syncSetCount();

    // --- raw file + paths --------------------------------------------------
    var rawHead = el("div", "cdbx-sec-h");
    rawHead.appendChild(el("span", "cdbx-sec-t", "The file itself"));
    panel.appendChild(rawHead);

    var rawToggle = el("button", "cdbx-btn", "Show the configuration file");
    rawToggle.type = "button";
    panel.appendChild(rawToggle);
    var rawBox = el("div", "cdbx-rawbox cdbx-hide");
    panel.appendChild(rawBox);

    var rawOpen = false;
    rawToggle.addEventListener("click", function () {
      rawOpen = !rawOpen;
      rawToggle.textContent = rawOpen ? "Hide the configuration file" : "Show the configuration file";
      if (!rawOpen) { rawBox.classList.add("cdbx-hide"); return; }
      rawBox.classList.remove("cdbx-hide");
      clear(rawBox);
      var loading = el("div", "cdbx-empty", "Reading...");
      rawBox.appendChild(loading);
      api.deployRaw().then(function (res) {
        clear(rawBox);
        if (failed(res)) {
          rawBox.appendChild(el("div", "cdbx-error", "Could not read the file: " + reason(res)));
          return;
        }
        var area = el("textarea", "cdbx-area cdbx-area-tall");
        area.rows = 14;
        area.spellcheck = false;
        area.value = res.text;
        area.disabled = !res.editable;
        rawBox.appendChild(area);
        rawBox.appendChild(el("div", "cdbx-note",
          "Exactly what Claude Desktop reads, except that stored secrets show as \"" +
          state.keepToken + "\" and are written back unchanged. An unknown key is rejected rather than " +
          "silently dropped: the same key would make a managed policy file be ignored whole."));
        if (res.editable) {
          var saveRaw = el("button", "cdbx-btn", "Save the file");
          saveRaw.type = "button";
          saveRaw.addEventListener("click", function () {
            saveRaw.disabled = true;
            api.deploySaveRaw(area.value).then(function (r) {
              saveRaw.disabled = false;
              if (failed(r)) { toast("Not saved: " + reason(r), true); return; }
              toast("Configuration file saved - reloading the panel");
              renderDeploy(panel);
            }, function (err) {
              saveRaw.disabled = false;
              toast("Not saved: " + (err && err.message ? err.message : String(err)), true);
            });
          });
          rawBox.appendChild(saveRaw);
        }
      }, function (err) {
        clear(rawBox);
        rawBox.appendChild(el("div", "cdbx-error",
          "Could not read the file: " + (err && err.message ? err.message : String(err))));
      });
    });

    panel.appendChild(pathRow("Configuration",
      state.local.file || state.paths.libDir, "deploy-config"));
    panel.appendChild(pathRow("Deployment mode", state.paths.modeFile, "deploy-mode"));
    panel.appendChild(pathRow("Managed policy" + (managed.present ? "" : " (absent)"),
      state.paths.etcFile, "managed"));

    if (state.local && state.local.unknown && state.local.unknown.length) {
      panel.appendChild(el("div", "cdbx-path",
        "Keys in the file this build does not know and therefore ignores: " +
        state.local.unknown.join(", ")));
    }
  }

  var PANELS = {
    themes: renderThemes,
    features: renderFeatures,
    models: renderModels,
    flags: renderFlags,
    deploy: renderDeploy
  };

  // --- mounting ------------------------------------------------------------

  // {dialog, container, rowTag, rows, header, list, items, panel, pane,
  //  paneDisplay, selection}. `items` are {cell, control} pairs: the cell is what
  //  the list holds and what is clicked, the control is what carries the look.
  var mounted = null;

  // Give the borrowed selection state back: our item drops what it took and the
  // upstream row that was selected when the user came to Extra gets it back. Both
  // sides are guarded - React may have replaced either node in the meantime.
  function releaseSelection() {
    var s = mounted && mounted.selection;
    if (!s) return;
    mounted.selection = null;
    if (s.fallback) {
      s.item.classList.remove("cdbx-sel-fb");
      return;
    }
    s.add.forEach(function (c) { s.item.classList.remove(c); });
    s.drop.forEach(function (c) { s.item.classList.add(c); });
    s.attrs.forEach(function (a) { s.item.removeAttribute(a.name); });
    if (s.node && s.node.isConnected) {
      s.add.forEach(function (c) { s.node.classList.add(c); });
      s.drop.forEach(function (c) { s.node.classList.remove(c); });
      s.attrs.forEach(function (a) { s.node.setAttribute(a.name, a.value); });
    }
  }

  // Take the real selected look over to our item. The look lives on the row's
  // CONTROL (the button), which is what `item` is here. Without a computable diff
  // we do NOT invent a pill - a subtle outline of our own says "this one" without
  // pretending to be upstream's.
  function selectOurs(item) {
    releaseSelection();
    if (!mounted) return;
    // Re-scan every group: the row selected right now may well live in a group
    // other than the one findNav measured, and React may have replaced nodes.
    var rows = mounted.rows;
    if (mounted.container && mounted.container.isConnected) {
      var wide = selectionRows(mounted.container, mounted.rowTag);
      if (wide.length < 2) wide = selectionRows(mounted.container, null);
      // The re-scan only replaces what we know if it is no narrower - and the
      // comparison has to be like for like. `wide` holds rows of the major tag
      // only, on purpose: a differently shaped row (the organization link) would
      // otherwise read as a second deviation and make the diff ambiguous. So it
      // is measured against the rows of that same tag, not against every row.
      var sameTag = 0;
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].tagName === mounted.rowTag) sameTag++;
      }
      if (wide.length >= sameTag) rows = wide;
    }
    var hit = findSelected(rows);
    if (!hit || (!hit.add.length && !hit.drop.length && !hit.attrs.length)) {
      diag("no-seldiff", "[ExtraSettings] no selected-row class diff could be computed in this nav - " +
        "Extra marks its active item with its own outline");
      item.classList.add("cdbx-sel-fb");
      mounted.selection = { fallback: true, item: item };
      return;
    }
    hit.add.forEach(function (c) { item.classList.add(c); hit.node.classList.remove(c); });
    hit.drop.forEach(function (c) { item.classList.remove(c); hit.node.classList.add(c); });
    hit.attrs.forEach(function (a) { item.setAttribute(a.name, a.value); hit.node.removeAttribute(a.name); });
    mounted.selection = {
      fallback: false, item: item, node: hit.node,
      add: hit.add, drop: hit.drop, attrs: hit.attrs
    };
  }

  function restoreUpstream() {
    if (!mounted) return;
    if (mounted.panel) mounted.panel.remove();
    if (mounted.pane && mounted.pane.isConnected) {
      mounted.pane.style.display = mounted.paneDisplay;
    }
    mounted.panel = null;
    mounted.pane = null;
    releaseSelection();
  }

  function show(kind, item) {
    if (!mounted) return;
    var pane = mounted.panel
      ? mounted.pane
      : findPane(mounted.dialog, mounted.container, mounted.rows);
    if (!pane) {
      diag("no-pane", "[ExtraSettings] found the settings nav but no content pane to take over - Extra is inert in this modal");
      toast("This settings dialog has an unexpected layout - use Ctrl+Shift+T for themes.", true);
      return;
    }
    if (!mounted.panel) {
      mounted.pane = pane;
      mounted.paneDisplay = pane.style.display;
      pane.style.display = "none";
      mounted.panel = el("div", "cdbx-panel");
      pane.parentElement.insertBefore(mounted.panel, pane.nextSibling);
      // Only possible once the panel is IN the document: it measures the modal.
      paintSurface(mounted.panel);
    }
    selectOurs(item.control);
    var render = PANELS[kind] || renderThemes;
    render(mounted.panel);
    mounted.panel.scrollTop = 0;
  }

  function install(dialog) {
    var found = findNav(dialog);
    if (!found.ok) {
      // Silent for dialogs that were never the settings modal (confirmations,
      // share sheets); one line only when it did look like settings.
      if (found.leaves > 0) {
        diag("no-nav", "[ExtraSettings] a dialog with " + found.leaves +
          " settings-like nav labels appeared but only " + (found.rows || 0) +
          " of them resolved to a nav row, so no container could be identified - " +
          "Extra not added; refit against baseline/SETTINGS_NAV_CAPTURE.md");
      }
      return false;
    }
    var container = found.container;

    // A previous mount may have left orphans behind if React recycled the
    // container without our items' listeners.
    var stale = dialog.querySelectorAll(".cdbx-group,.cdbx-item");
    for (var s = 0; s < stale.length; s++) stale[s].remove();

    var rowTag = majorTag(found.rows);
    var selected = findSelected(selectionRows(container, rowTag));
    var anchor = findAnchor(container);
    // The group's own list, so header and rows come from the SAME group; the
    // biggest list is the fallback when that group has none (the bare-link shape).
    var list = anchor && isList(anchor.header.nextElementSibling)
      ? anchor.header.nextElementSibling
      : found.primaryList;
    var template = pickTemplate(list, found.rows, selected && selected.node);
    if (!template) {
      diag("no-template", "[ExtraSettings] the settings nav offers no row to clone - Extra not added");
      return false;
    }
    shapeDiag(container, anchor, list, template, found.rows.length, found.via);

    // PRIMARY: two siblings before the anchor header, exactly as upstream lays
    // its own groups out. Both must live at the container's level or the pair
    // would end up split.
    var built = null;
    if (anchor && list &&
        anchor.header.parentElement === container && list.parentElement === container) {
      built = buildGroup(anchor, list, template);
      container.insertBefore(built.header, anchor.header);
      container.insertBefore(built.list, anchor.header);
    } else {
      diag("fabricated", "[ExtraSettings] no group header to insert next to (" +
        (anchor ? "its list is not a sibling of the header" :
          "neither a known group header text nor a group header shape in the nav") +
        ") - Extra appends its rows behind a divider instead");
      built = fabricateGroup(container, lastList(container), template);
    }

    var items = built.items;

    mounted = {
      dialog: dialog,
      container: container,
      rowTag: rowTag,
      rows: found.rows,
      header: built.header,
      list: built.list,
      items: items,
      panel: null,
      pane: null,
      paneDisplay: "",
      selection: null
    };

    for (var b = 0; b < items.length; b++) bindItem(items[b], items[b].kind);

    // Any click on an upstream nav row hands the pane and the selected look back.
    // Capture phase, so upstream's own handler still runs and renders into the
    // restored pane. The listener sits on the container - the level our header and
    // list live at - so rows of every group are covered.
    container.addEventListener("click", function (ev) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].cell.contains(ev.target)) return;
      }
      restoreUpstream();
    }, true);

    diag("installed", "[ExtraSettings] Extra nav group added to the settings dialog (" +
      found.rows.length + " upstream nav rows, " +
      (built.fallback ? "appended behind a divider" :
        built.label === "#structure" ? "cloned from the group found by structure, not by label" :
          built.label === "#last-group" ? "cloned from the last group, found by structure" :
            "cloned from the \"" + built.label + "\" group") + ")");
    return true;
  }

  // Our rows are clones, so they carry no React handler: these are the only ones.
  // A cloned <button> activates on Enter and Space by itself; anything else needs
  // the key handler, and would fire twice if a button had one too.
  function bindItem(item, kind) {
    item.cell.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      show(kind, item);
    });
    if (item.control.tagName === "BUTTON") return;
    item.control.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      ev.preventDefault();
      ev.stopPropagation();
      show(kind, item);
    });
  }

  // One line, once per page: the structure we anchored on, for the next refit.
  // Which anchors were found matters as much as their shape - "hdr=-" is the
  // signature of upstream having renamed or restructured its group headers.
  //
  // The anchor is named by its LABEL only when that label is one of ours; a
  // structurally found header is named by the tier that found it, because its
  // own text is the user's interface language and page text never goes in here.
  function shapeDiag(container, anchor, list, template, rowCount, via) {
    diag("shape", ("[ExtraSettings] nav shape rows=" + rowCount +
      " box=" + shapeOf(container, 1) +
      " hdr[" + (anchor ? anchor.label : "-") + "]=" + (anchor ? shapeOf(anchor.header, 1) : "-") +
      " list=" + (list ? shapeOf(list, 1) : "-") +
      " item=" + shapeOf(template, 3) +
      " icon=" + (template.querySelector(ICON_SEL) ? "box" :
        template.querySelector("svg") ? "svg" : "none") +
      " via=" + (via || "-")).slice(0, 300));
  }

  function attached() {
    return !!(mounted && mounted.header.isConnected && mounted.items[0].cell.isConnected &&
      (!mounted.list || mounted.list.isConnected));
  }

  function scan() {
    if (attached()) return;
    // Our nav items are gone but a previous mount may still be live: if the SPA
    // re-rendered the nav while our panel was open, hand the pane back before
    // forgetting about it, or it stays display:none with an orphan panel next to
    // it and the modal looks broken.
    if (mounted) {
      restoreUpstream();
      mounted = null;
    }
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      if (install(dialogs[i])) return;
    }
  }

  // Never swallow a scan error silently - a broken scan is exactly the failure
  // that must show up in the log instead of a mysteriously missing nav item.
  function safeScan() {
    try {
      scan();
    } catch (e) {
      diag("scan-error", "[ExtraSettings] settings-dialog scan failed: " + ((e && e.message) || String(e)));
    }
  }

  // One persistent observer covers modal open/close and SPA route changes; a
  // real reload re-fires dom-ready and re-runs this script from scratch.
  var pending = null;
  var observer = new MutationObserver(function (records) {
    if (pending) return;
    // Element insertions only: chat streaming mutates text constantly and a
    // scan per keystroke would be wasteful.
    var relevant = false;
    for (var i = 0; i < records.length && !relevant; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j].nodeType === 1) { relevant = true; break; }
      }
    }
    if (!relevant) return;
    pending = setTimeout(function () { pending = null; safeScan(); }, 80);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  safeScan();

  return "extra-settings: installed, watching for the settings dialog";
})();
