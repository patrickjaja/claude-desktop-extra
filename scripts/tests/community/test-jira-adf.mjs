#!/usr/bin/env node
// js/jira_tracker_adf.js: node and mark allowlist, link schemes, media placeholder, ADF -> Markdown, length limit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = readFileSync(join(ROOT, "js/jira_tracker_adf.js"), "utf8");
const ctx = vm.createContext({ URL });
vm.runInContext(SRC, ctx);
const adf = ctx.__cdbJiraAdf;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("PASS " + name); };

function fakeDocument() {
  function node(kind, tag) {
    const n = { kind, tagName: tag ? String(tag).toUpperCase() : "", children: [], attrs: {}, className: "", text: "" };
    for (const k of ["innerHTML", "outerHTML"]) Object.defineProperty(n, k, { get() { throw new Error(k + " read"); }, set() { throw new Error(k + " written"); } });
    Object.defineProperty(n, "textContent", {
      get() { return n.kind === "text" ? n.text : n.children.map((c) => c.textContent).join(""); },
      set(v) { if (n.kind === "text") n.text = String(v); else n.children = v === "" ? [] : [textNode(String(v))]; }
    });
    n.appendChild = (c) => { n.children.push(c); return c; };
    n.setAttribute = (k, v) => { n.attrs[k] = String(v); };
    n.insertAdjacentHTML = () => { throw new Error("insertAdjacentHTML used"); };
    return n;
  }
  function textNode(t) { const n = node("text"); n.text = t; return n; }
  return { createElement: (t) => node("el", t), createTextNode: (t) => textNode(String(t)) };
}
function html(n) {
  if (n.kind === "text") return n.text;
  const tag = n.tagName.toLowerCase();
  const at = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join("") + (n.className ? ` class="${n.className}"` : "");
  return `<${tag}${at}>${n.children.map(html).join("")}</${tag}>`;
}
const t = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const p = (...content) => ({ type: "paragraph", content });
const doc = (...content) => ({ type: "doc", version: 1, content });
const render = (d) => html(adf.render(d, fakeDocument()));

test("allowlists match the spec", () => {
  assert.deepEqual([...adf.NODES], ["doc", "paragraph", "text", "hardBreak", "heading", "bulletList", "orderedList", "listItem", "codeBlock",
    "blockquote", "rule", "table", "tableRow", "tableHeader", "tableCell", "panel", "mention", "emoji", "status", "date", "inlineCard"]);
  assert.deepEqual([...adf.MARKS], ["strong", "em", "code", "strike", "underline", "link"]);
  assert.equal(adf.LIMIT, 20000);
});
test("the source never writes HTML strings", () => {
  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) assert.ok(!SRC.includes(banned), banned);
});
test("render: blocks and marks become elements, text stays text", () => {
  const out = render(doc(
    { type: "heading", attrs: { level: 9 }, content: [t("Title")] },
    p(t("bold", [{ type: "strong" }]), t(" "), t("both", [{ type: "em" }, { type: "underline" }]), t("x", [{ type: "unknownMark" }])),
    { type: "bulletList", content: [{ type: "listItem", content: [p(t("one"))] }] },
    { type: "codeBlock", attrs: { language: "js" }, content: [t("a<b>")] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [p(t("H"))] }, { type: "tableCell", content: [p(t("C"))] }] }] },
    { type: "rule" }
  ));
  assert.equal(out, '<div class="adf"><h6>Title</h6><p><strong>bold</strong> <u><em>both</em></u>x</p><ul><li><p>one</p></li></ul>' +
    '<pre class="adf-code"><code>a<b></code></pre><table class="adf-table"><tbody><tr><th><p>H</p></th><td><p>C</p></td></tr></tbody></table><hr></hr></div>');
});
test("render: links keep only https and mailto", () => {
  const link = (href) => t("go", [{ type: "link", attrs: { href } }]);
  const out = render(doc(p(link("https://acme.atlassian.net/browse/A-1"), link("mailto:a@b.c"), link("javascript:alert(1)"), link("http://x.test"), link("file:///etc/passwd"), link("//evil.test"))));
  assert.equal(out, '<div class="adf"><p><a href="https://acme.atlassian.net/browse/A-1" class="adf-link">go</a><a href="mailto:a@b.c" class="adf-link">go</a>gogogogo</p></div>');
  assert.equal(render(doc(p({ type: "inlineCard", attrs: { url: "javascript:x" } }))), '<div class="adf"><p>javascript:x</p></div>');
});
test("render: media is a text placeholder, unknown nodes are their text", () => {
  const out = render(doc({ type: "mediaSingle", content: [{ type: "media", attrs: { id: "1", type: "file" } }] },
    { type: "expand", content: [p(t("hidden "), t("text"))] }, { type: "extension", attrs: { text: "x" } }));
  assert.equal(out, '<div class="adf"><span class="adf-media">attachment — open in Jira</span>hidden text</div>');
  assert.equal(render(doc(p({ type: "mention", attrs: { id: "1", text: "@Ada" } }, { type: "status", attrs: { text: "DONE" } }, { type: "date", attrs: { timestamp: "1700000000000" } }))),
    '<div class="adf"><p><span class="adf-mention">@Ada</span><span class="adf-status">DONE</span><span class="adf-date">2023-11-14</span></p></div>');
});
test("render: a media hook replaces attached media; containers keep their children; null falls back to the placeholder", () => {
  const seen = [];
  const media = (a, d) => { seen.push(a.id); if (a.id === "skip") return null; const n = d.createElement("img"); n.setAttribute("data-id", a.id); return n; };
  const out = html(adf.render(doc({ type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", type: "file", alt: "x.png" } }] },
    { type: "mediaGroup", content: [{ type: "media", attrs: { id: "m2" } }, { type: "media", attrs: { id: "skip" } }] }, p({ type: "mediaInline", attrs: { id: "m3" } })), fakeDocument(), { media }));
  assert.deepEqual(seen, ["m1", "m2", "skip", "m3"]);
  assert.equal(out, '<div class="adf"><div class="adf-media-single"><img data-id="m1"></img></div><div class="adf-media-group"><img data-id="m2"></img><span class="adf-media">attachment — open in Jira</span></div><p><img data-id="m3"></img></p></div>');
});
test("render and markdown survive null, junk and very deep documents", () => {
  for (const bad of [null, undefined, 7, "x", [], { type: "doc", content: "nope" }, { type: "doc", content: [null, 5, { content: [] }] }]) {
    assert.equal(render(bad), '<div class="adf"></div>');
    assert.equal(adf.toMarkdown(bad), "");
  }
  let deep = t("bottom");
  for (let i = 0; i < 5000; i++) deep = { type: "blockquote", content: [deep] };
  assert.doesNotThrow(() => render(doc(deep)));
  assert.doesNotThrow(() => adf.toMarkdown(doc(deep)));
});
test("markdown: headings, lists, code, quote, table, marks, links", () => {
  const md = adf.toMarkdown(doc(
    { type: "heading", attrs: { level: 2 }, content: [t("Goal")] },
    p(t("Use "), t("x()", [{ type: "code" }]), t(" and "), t("docs", [{ type: "link", attrs: { href: "https://example.com/d" } }]), t(" "), t("bad", [{ type: "link", attrs: { href: "javascript:x" } }])),
    { type: "orderedList", attrs: { order: 3 }, content: [{ type: "listItem", content: [p(t("a")), { type: "bulletList", content: [{ type: "listItem", content: [p(t("b"))] }] }] }] },
    { type: "codeBlock", attrs: { language: "sh" }, content: [t("echo ```")] },
    { type: "blockquote", content: [p(t("q1")), p(t("q2"))] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [p(t("k|v"))] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [p(t("1"))] }, { type: "tableCell", content: [p(t("2"))] }] }] },
    { type: "mediaGroup", content: [{ type: "media", attrs: {} }] }
  ));
  assert.equal(md, "## Goal\n\nUse `x()` and [docs](https://example.com/d) bad\n\n3. a\n   - b\n\n~~~~sh\necho ```\n~~~~\n\n> q1\n> \n> q2\n\n| k\\|v |  |\n| --- | --- |\n| 1 | 2 |\n\n[attachment]");
});
test("markdown: length limit adds the truncated marker", () => {
  const long = doc(p(t("x".repeat(30000))));
  const md = adf.toMarkdown(long);
  assert.equal(md.length, 20000 + "\n[truncated]".length);
  assert.ok(md.endsWith("\n[truncated]"));
  assert.equal(adf.toMarkdown(long, 10), "xxxxxxxxxx\n[truncated]");
  assert.equal(adf.toMarkdown(doc(p(t("short")))), "short");
});
console.log(`PASS ${passed} Jira ADF tests`);
