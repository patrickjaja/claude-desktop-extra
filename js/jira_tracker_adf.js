;/*__CDB_JIRA_ADF__*/(function (root) {
  "use strict";
  if (root.__cdbJiraAdf) return;
  var NODES = ["doc", "paragraph", "text", "hardBreak", "heading", "bulletList", "orderedList", "listItem", "codeBlock",
    "blockquote", "rule", "table", "tableRow", "tableHeader", "tableCell", "panel", "mention", "emoji", "status", "date", "inlineCard"];
  var MARKS = ["strong", "em", "code", "strike", "underline", "link"];
  var MEDIA = ["media", "mediaSingle", "mediaGroup", "mediaInline"];
  var MARK_TAGS = { strong: "strong", em: "em", code: "code", strike: "s", underline: "u" };
  var BLOCK_TAGS = { paragraph: "p", bulletList: "ul", orderedList: "ol", listItem: "li", blockquote: "blockquote",
    tableRow: "tr", tableHeader: "th", tableCell: "td", panel: "div" };
  var MAX_DEPTH = 64;
  var PAGE_MEDIA = "attachment — open in Jira";
  var PROMPT_MEDIA = "[attachment]";
  var LIMIT = 20000;

  function has(list, v) { return list.indexOf(v) >= 0; }
  function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  function kids(n) { return n && Array.isArray(n.content) ? n.content : []; }
  function attrs(n) { return (n && obj(n.attrs)) || {}; }
  function str(v) { return typeof v === "string" ? v : ""; }
  function level(a) { return Math.min(6, Math.max(1, Number(a.level) | 0 || 1)); }

  function safeHref(href) {
    var s = str(href).trim();
    if (!s) return "";
    var u;
    try { u = new URL(s); } catch (e) { return ""; }
    return u.protocol === "https:" || u.protocol === "mailto:" ? u.href : "";
  }
  function dateText(a) {
    var t = Number(a.timestamp);
    return isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : "";
  }
  function leafText(n) {
    var a = attrs(n);
    switch (n.type) {
      case "text": return str(n.text);
      case "hardBreak": return "\n";
      case "mention": return str(a.text) || "@user";
      case "emoji": return str(a.text) || str(a.shortName);
      case "status": return str(a.text);
      case "date": return dateText(a);
      case "inlineCard": return str(a.url);
    }
    return null;
  }
  function plainText(n, depth, media) {
    n = obj(n);
    if (!n || depth > MAX_DEPTH) return "";
    if (has(MEDIA, n.type)) return media;
    var leaf = leafText(n);
    if (leaf !== null) return leaf;
    return kids(n).map(function (c) { return plainText(c, depth + 1, media); }).join("");
  }

  function markText(text, marks) {
    var out = text, href = "";
    (Array.isArray(marks) ? marks : []).forEach(function (m) {
      m = obj(m);
      if (!m || !has(MARKS, m.type) || !out) return;
      if (m.type === "code") out = out.indexOf("`") >= 0 ? "`` " + out + " ``" : "`" + out + "`";
      else if (m.type === "strong") out = "**" + out + "**";
      else if (m.type === "em") out = "*" + out + "*";
      else if (m.type === "strike") out = "~~" + out + "~~";
      else if (m.type === "link") href = safeHref(attrs(m).href);
    });
    return href ? "[" + out + "](" + href + ")" : out;
  }
  function inlineMd(nodes, depth) {
    return nodes.map(function (c) {
      c = obj(c);
      if (!c || depth > MAX_DEPTH) return "";
      if (c.type === "text") return markText(str(c.text), c.marks);
      if (has(MEDIA, c.type)) return PROMPT_MEDIA;
      if (c.type === "inlineCard") { var h = safeHref(attrs(c).url); return h ? "<" + h + ">" : str(attrs(c).url); }
      var leaf = leafText(c);
      return leaf !== null ? leaf : plainText(c, depth + 1, PROMPT_MEDIA);
    }).join("");
  }
  function blocksMd(nodes, depth, sep) {
    return nodes.map(function (c) { return blockMd(c, depth + 1); })
      .filter(function (s) { return s !== ""; }).join(sep === undefined ? "\n\n" : sep);
  }
  function quote(text) { return text.split("\n").map(function (l) { return "> " + l; }).join("\n"); }
  function listItemMd(li, prefix, depth) {
    var pad = new Array(prefix.length + 1).join(" ");
    return blocksMd(kids(obj(li)), depth + 1, "\n").split("\n")
      .map(function (l, i) { return (i ? pad : prefix) + l; }).join("\n");
  }
  function tableMd(n, depth) {
    var rows = kids(n).map(function (r) {
      return kids(obj(r)).map(function (cell) {
        return blocksMd(kids(obj(cell)), depth + 2, " ").replace(/\n/g, " ").replace(/\|/g, "\\|");
      });
    }).filter(function (r) { return r.length > 0; });
    if (!rows.length) return "";
    var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    function line(r) {
      var cells = r.slice();
      while (cells.length < width) cells.push("");
      return "| " + cells.join(" | ") + " |";
    }
    return [line(rows[0]), "|" + new Array(width + 1).join(" --- |")].concat(rows.slice(1).map(line)).join("\n");
  }
  function blockMd(n, depth) {
    n = obj(n);
    if (!n || depth > MAX_DEPTH) return "";
    var c = kids(n), a = attrs(n);
    switch (n.type) {
      case "doc": return blocksMd(c, depth);
      case "paragraph": return inlineMd(c, depth);
      case "heading": return new Array(level(a) + 1).join("#") + " " + inlineMd(c, depth);
      case "bulletList": return c.map(function (li) { return listItemMd(li, "- ", depth); }).join("\n");
      case "orderedList":
        var start = Number(a.order) | 0 || 1;
        return c.map(function (li, i) { return listItemMd(li, (start + i) + ". ", depth); }).join("\n");
      case "codeBlock":
        var body = plainText(n, depth, PROMPT_MEDIA);
        var fence = body.indexOf("```") >= 0 ? "~~~~" : "```";
        return fence + str(a.language).replace(/[^\w+#-]/g, "") + "\n" + body + "\n" + fence;
      case "blockquote": case "panel": return quote(blocksMd(c, depth));
      case "rule": return "---";
      case "table": return tableMd(n, depth);
    }
    if (has(MEDIA, n.type)) return PROMPT_MEDIA;
    return has(NODES, n.type) ? inlineMd(c, depth) : plainText(n, depth, PROMPT_MEDIA);
  }
  function toMarkdown(doc, max) {
    var limit = typeof max === "number" && max > 0 ? max : LIMIT, out = "";
    try { out = blockMd(doc, 0); } catch (e) { out = ""; }
    out = out.replace(/\n{3,}/g, "\n\n").trim();
    return out.length > limit ? out.slice(0, limit) + "\n[truncated]" : out;
  }

  function el(d, tag, cls, text) {
    var e = d.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function renderText(n, d) {
    var node = d.createTextNode(str(n.text));
    (Array.isArray(n.marks) ? n.marks : []).forEach(function (m) {
      m = obj(m);
      if (!m || !has(MARKS, m.type)) return;
      var w;
      if (m.type === "link") {
        var h = safeHref(attrs(m).href);
        if (!h) return;
        w = el(d, "a", "adf-link");
        w.setAttribute("href", h);
      } else w = el(d, MARK_TAGS[m.type]);
      w.appendChild(node);
      node = w;
    });
    return node;
  }
  function renderChildren(n, parent, d, depth) {
    kids(n).forEach(function (c) { renderNode(c, parent, d, depth + 1); });
    return parent;
  }
  var mediaHook = null;
  function renderNode(n, parent, d, depth) {
    n = obj(n);
    if (!n || depth > MAX_DEPTH) return;
    var t = n.type, a = attrs(n);
    if (has(MEDIA, t)) {
      if (!mediaHook) { parent.appendChild(el(d, "span", "adf-media", PAGE_MEDIA)); return; }
      if (t === "mediaSingle" || t === "mediaGroup") { parent.appendChild(renderChildren(n, el(d, "div", t === "mediaSingle" ? "adf-media-single" : "adf-media-group"), d, depth)); return; }
      var shown = null;
      try { shown = mediaHook(a, d); } catch (e) { shown = null; }
      parent.appendChild(shown || el(d, "span", "adf-media", PAGE_MEDIA));
      return;
    }
    if (t === "doc") { renderChildren(n, parent, d, depth); return; }
    if (t === "text") { parent.appendChild(renderText(n, d)); return; }
    if (t === "hardBreak") { parent.appendChild(d.createElement("br")); return; }
    if (t === "rule") { parent.appendChild(d.createElement("hr")); return; }
    if (t === "inlineCard") {
      var h = safeHref(a.url);
      if (!h) { parent.appendChild(d.createTextNode(str(a.url))); return; }
      var link = el(d, "a", "adf-link", str(a.url));
      link.setAttribute("href", h);
      parent.appendChild(link);
      return;
    }
    if (t === "mention" || t === "emoji" || t === "status" || t === "date") { parent.appendChild(el(d, "span", "adf-" + t, leafText(n))); return; }
    if (t === "codeBlock") { var pre = el(d, "pre", "adf-code"); pre.appendChild(el(d, "code", "", plainText(n, depth, PAGE_MEDIA))); parent.appendChild(pre); return; }
    if (t === "heading") { parent.appendChild(renderChildren(n, el(d, "h" + level(a)), d, depth)); return; }
    if (t === "table") { var table = el(d, "table", "adf-table"); table.appendChild(renderChildren(n, el(d, "tbody"), d, depth)); parent.appendChild(table); return; }
    if (BLOCK_TAGS[t]) { parent.appendChild(renderChildren(n, el(d, BLOCK_TAGS[t], t === "panel" ? "adf-panel" : ""), d, depth)); return; }
    parent.appendChild(d.createTextNode(plainText(n, depth, PAGE_MEDIA)));
  }
  function render(doc, d, opts) {
    var box = el(d, "div", "adf"), prev = mediaHook;
    mediaHook = opts && typeof opts.media === "function" ? opts.media : null;
    try { renderNode(doc, box, d, 0); } catch (e) { box.textContent = plainText(doc, 0, PAGE_MEDIA); }
    finally { mediaHook = prev; }
    return box;
  }

  root.__cdbJiraAdf = { NODES: NODES, MARKS: MARKS, LIMIT: LIMIT, safeHref: safeHref, toMarkdown: toMarkdown, render: render };
})(typeof globalThis !== "undefined" ? globalThis : window);
