#!/usr/bin/env node
// Monitor names in our Computer Use tool handler (js/cu_handler_injection.js:
// X11, wlroots, GNOME, background display).
//
// WHY THIS EXISTS
// ---------------
// switch_display used to match `label === target || displayId === target`,
// first hit wins, and listed raw labels. Electron's labels repeat (both
// monitors of a VM are "Unknown Display"; two identical monitors carry the
// same EDID name), so the second one could not be reached by name, and the
// model could not tell them apart in the "Available:" lists. Upstream's own
// dispatcher (kwin mode) names monitors by a rule of its own (a sanitized
// label, else "display <id>", " (2)", " (3)" for repeats, in displayId order)
// and adds a note to every screenshot that names the captured monitor and the
// others; the switch_display tool description tells the model to take the name
// from that note. Our handler now uses the same names and the same note.
//
// This harness runs the real handler on a stub executor and pins:
//   [1] the names: unique labels stay byte-identical (switch_display texts as
//       before), two "Unknown Display" monitors become "Unknown Display" and
//       "Unknown Display (2)", odd or over-long labels become "display <id>";
//       the rule matches upstream's own function, cut from the extract;
//   [2] switch_display: the disambiguated name (any case, trimmed), the
//       repeated raw label = its first monitor (as upstream resolves it), the
//       displayId as before, a unique raw label that the rule renames, the
//       not-found and auto texts;
//   [3] the screenshot note: upstream's wording (compared with the bundle),
//       none with one monitor, "different from your previous screenshot"
//       after a switch, before the image;
//   [4] the accessibility tools get the same names (opts.dname).
// CDB_BUNDLE_DIR points at another extract ([1]'s and [3]'s upstream cases
// are skipped without one).
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HSRC = readFileSync(path.join(ROOT, "js", "cu_handler_injection.js"), "utf8");
const BUILD_DIR = path.join(process.env.CDB_BUNDLE_DIR || path.join(ROOT, "tmp", "app.asar.contents"), ".vite", "build");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra !== undefined ? "  -> " + extra : "")); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
}
const J = JSON.stringify;

// Brace-balanced cut of `function NAME(` out of src.
function cutFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error("unbalanced " + name);
}

// The real handler, the way sub-patch 6 stages it (an async function body).
const run = new Function("__TOOL_NAME__", "__INPUT__", "__SESSION__", "__SELF__", "__STATE__", "__MAKE_DISPATCH__", "require",
  "return (async()=>{" + HSRC + "\n})()");
const mon = (displayId, label, x, width, height, isPrimary = false) => ({ displayId, label, width, height, originX: x, originY: 0, scaleFactor: 1, isPrimary });
function stub(displays) {
  const shots = [];
  globalThis.__linuxExecutor = {
    async listDisplays() { return displays.map((d) => ({ ...d })); },
    async screenshot(o) {
      shots.push(o.displayId);
      const m = displays.find((d) => d.displayId === o.displayId) || displays[0];
      return { base64: "AA==", mimeType: "image/png", imgW: m.width, imgH: m.height, displayWidth: m.width, displayHeight: m.height, displayId: m.displayId, originX: m.originX, originY: m.originY };
    },
  };
  globalThis.__cuPinnedDisplay = undefined; globalThis.__cuLastShot = null; globalThis.__cuActiveOrigin = { x: 0, y: 0 };
  globalThis.__cuNoteShotDisplay = undefined;
  return shots;
}
globalThis.__cdbDiag = () => {};
const call = (tool, input) => run(tool, input, null, {}, {}, null, () => { throw new Error("unexpected require"); });
const text = (r) => (r && r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");

const HN = ["__dispNfc", "__dispLabel", "__dispNames", "__dispName", "__dispFind", "__dispNote"];
const H = new Function(HSRC.match(/var __DISP_OK=.*\n/)[0] + HN.map((n) => cutFn(HSRC, n)).join("\n") + "\nreturn{" + HN.join(",") + "};")();

const VM = [mon(0, "Unknown Display", 0, 1920, 1080, true), mon(1, "Unknown Display", 1920, 1280, 800)];
const UNIQUE = [mon(0, "DP-1", 0, 1920, 1080, true), mon(1, "HDMI-A-1", 1920, 1280, 800)];

// ── [1] names ──────────────────────────────────────────────────────────────
console.log("\n[1] names");
{
  const n = H.__dispNames(VM);
  ok(n.get(0) === "Unknown Display" && n.get(1) === "Unknown Display (2)", "two \"Unknown Display\": the second is \"Unknown Display (2)\"", J([...n]));
  const r = H.__dispNames([VM[1], VM[0]]);
  ok(r.get(0) === "Unknown Display" && r.get(1) === "Unknown Display (2)", "numbered in displayId order, not list order", J([...r]));
  const three = H.__dispNames([mon(2, "LG", 0, 1, 1), mon(0, "LG", 0, 1, 1), mon(1, "LG", 0, 1, 1)]);
  ok(J([...three].sort()) === J([[0, "LG"], [1, "LG (2)"], [2, "LG (3)"]]), "three alike: (2), (3)", J([...three]));
  const u = H.__dispNames(UNIQUE);
  ok(u.get(0) === "DP-1" && u.get(1) === "HDMI-A-1", "unique labels: their own names", J([...u]));
  const odd = H.__dispNames([mon(0, "  Dell “U2720Q”  ", 0, 1, 1), mon(1, "", 0, 1, 1), mon(2, "x".repeat(41), 0, 1, 1), mon(3, "bad\u0007name", 0, 1, 1), mon(4, undefined, 0, 1, 1)]);
  ok(J([...odd]) === J([[0, "Dell \"U2720Q\""], [1, "display 1"], [2, "display 2"], [3, "display 3"], [4, "display 4"]]), "trimmed, plain quotes; empty / over 40 / control characters / none: \"display <id>\"", J([...odd]));
  // The same rule as upstream's own function, cut from the extract.
  const chunks = existsSync(BUILD_DIR) ? readdirSync(BUILD_DIR).filter((f) => /^index.*\.js$/.test(f)) : [];
  let up = null;
  for (const c of chunks) {
    const src = readFileSync(path.join(BUILD_DIR, c), "utf8");
    const m = /function ([\w$]+)\(e\)\{let t=\[\.\.\.e\]\.sort\(\(\(e,t\)=>e\.displayId-t\.displayId\)\),n=new Map,r=new Map;for\(let e of t\)\{let t=([\w$]+)\(e\.label\)\?\?`display \$\{e\.displayId\}`/.exec(src);
    if (!m) continue;
    // The label sanitizer and its helpers: function V(e){let t=Qe(e);...}, Qe, Ze, Ye, Xe.
    const v = cutFn(src, m[2]), q = /let t=([\w$]+)\(e\)/.exec(v)[1], qf = cutFn(src, q), z = /t=([\w$]+)\(t\);for/.exec(qf)[1];
    const ye = /&&([\w$]+)\.test\(t\)/.exec(v)[1], xe = /for\(let\[e,n\]of ([\w$]+)\)/.exec(qf)[1];
    const decl = (name) => { const mm = new RegExp("[,; ]" + name.replace(/\$/g, "\\$") + "=(/\\^\\[[^\\n]*?\\]\\+\\$/u|\\[\\[[^\\n]*?\\]\\])[,;]").exec(src); if (!mm) throw new Error("no " + name); return "var " + name + "=" + mm[1] + ";"; };
    up = new Function(decl(ye) + decl(xe) + cutFn(src, z) + qf + v + cutFn(src, m[1]) + "\nreturn " + m[1] + ";")();
    break;
  }
  if (!up) console.log("  SKIP upstream's naming function: no extract, or its shape moved");
  else {
    const sets = [VM, [VM[1], VM[0]], UNIQUE, [mon(2, "LG", 0, 1, 1), mon(0, "LG", 0, 1, 1), mon(1, "LG", 0, 1, 1)], [mon(0, "  Dell “U2720Q”  ", 0, 1, 1), mon(1, "", 0, 1, 1), mon(2, "x".repeat(41), 0, 1, 1), mon(3, "bad\u0007name", 0, 1, 1), mon(4, undefined, 0, 1, 1)], [mon(0, "display 1", 0, 1, 1), mon(1, "", 0, 1, 1)], [mon(0, "Café → 1", 0, 1, 1), mon(1, "a…", 0, 1, 1)]];
    for (const s of sets) {
      const a = J([...H.__dispNames(s)].sort()), b = J([...up(s)].sort());
      ok(a === b, "= upstream's names for " + J(s.map((d) => d.label)), a + (a === b ? "" : " vs " + b));
    }
  }
}

// ── [2] switch_display ─────────────────────────────────────────────────────
console.log("\n[2] switch_display");
{
  stub(UNIQUE);
  const a = await call("switch_display", { display: "auto" });
  ok(text(a) === "Display mode set to auto (follows cursor). Available: DP-1 (1920x1080), HDMI-A-1 (1280x800)", "unique labels: the auto reply as before (byte-identical)", text(a));
  const s = await call("switch_display", { display: "HDMI-A-1" });
  ok(text(s) === "Switched to display: HDMI-A-1 (1280x800). Take a screenshot to refresh coordinates." && globalThis.__cuPinnedDisplay === 1, "unique labels: \"Switched to display\" as before", text(s));
  const nf = await call("switch_display", { display: "eDP-1" });
  ok(text(nf) === "Display 'eDP-1' not found. Available: DP-1, HDMI-A-1", "unique labels: the not-found text as before", text(nf));
  const id = await call("switch_display", { display: "0" });
  ok(globalThis.__cuPinnedDisplay === 0 && /^Switched to display: DP-1 /.test(text(id)), "the displayId still works", text(id));
  const ci = await call("switch_display", { display: "  hdmi-a-1 " });
  ok(globalThis.__cuPinnedDisplay === 1, "a name in another case, with spaces: found", text(ci));

  stub(VM);
  const a2 = await call("switch_display", { display: "auto" });
  ok(text(a2) === "Display mode set to auto (follows cursor). Available: Unknown Display (1920x1080), Unknown Display (2) (1280x800)", "two alike: auto lists both apart", text(a2));
  const s2 = await call("switch_display", { display: "Unknown Display (2)" });
  ok(globalThis.__cuPinnedDisplay === 1 && text(s2) === "Switched to display: Unknown Display (2) (1280x800). Take a screenshot to refresh coordinates.", "\"Unknown Display (2)\" reaches the second monitor", text(s2));
  const s3 = await call("switch_display", { display: "unknown display (2)" });
  ok(globalThis.__cuPinnedDisplay === 1, "... in lower case too");
  const s4 = await call("switch_display", { display: "Unknown Display" });
  ok(globalThis.__cuPinnedDisplay === 0 && /^Switched to display: Unknown Display \(1920x1080\)/.test(text(s4)), "the repeated raw label: the first monitor, as upstream resolves it", text(s4));
  const s5 = await call("switch_display", { display: 1 });
  ok(globalThis.__cuPinnedDisplay === 1 && /^Switched to display: Unknown Display \(2\) /.test(text(s5)), "the numeric displayId still works", text(s5));
  const nf2 = await call("switch_display", { display: "Unknown Display (3)" });
  ok(text(nf2) === "Display 'Unknown Display (3)' not found. Available: Unknown Display, Unknown Display (2)", "not found: the names", text(nf2));

  const LONG = "Some Vendor Ultra Wide Curved Gaming Monitor 49";
  stub([mon(0, "DP-1", 0, 1920, 1080, true), mon(1, LONG, 1920, 1280, 800)]);
  const l1 = await call("switch_display", { display: LONG });
  ok(globalThis.__cuPinnedDisplay === 1 && /^Switched to display: display 1 /.test(text(l1)), "a unique raw label the rule renames (over 40 characters) still resolves; the reply uses the name", text(l1));
  const l2 = await call("switch_display", { display: "display 1" });
  ok(globalThis.__cuPinnedDisplay === 1, "... and its name \"display 1\" too");
}

// ── [3] the screenshot note ────────────────────────────────────────────────
console.log("\n[3] screenshot note");
{
  stub([mon(0, "DP-1", 0, 1920, 1080, true)]);
  const one = await call("screenshot", {});
  ok(one.content.length === 1 && one.content[0].type === "image", "one monitor: no note (content unchanged)", J(one.content.map((b) => b.type)));

  stub(VM);
  const s1 = await call("screenshot", {});
  ok(s1.content[0].type === "text" && s1.content[1].type === "image", "two monitors: the note comes before the image, as upstream's", J(s1.content.map((b) => b.type)));
  ok(text(s1) === "This screenshot was taken on monitor \"Unknown Display\". Other attached monitors: \"Unknown Display (2)\". Use switch_display to capture a different monitor.", "first screenshot: the monitor and the others by name", text(s1));
  // Upstream treats a previous screenshot on display 0 like none (its
  // `prev === undefined || prev === 0` test): the plain note, kept as is.
  await call("switch_display", { display: "Unknown Display (2)" });
  const s2 = await call("screenshot", {});
  ok(text(s2) === "This screenshot was taken on monitor \"Unknown Display (2)\". Other attached monitors: \"Unknown Display\". Use switch_display to capture a different monitor.", "after switch_display from display 0: the plain note (as upstream)", text(s2));
  const s3 = await call("screenshot", {});
  ok(s3.content.length === 1 && s3.content[0].type === "image", "the same monitor again (not display 0): no note, as upstream", J(s3.content.map((b) => b.type)));
  await call("switch_display", { display: "Unknown Display" });
  const s4 = await call("screenshot", {});
  ok(text(s4) === "This screenshot was taken on monitor \"Unknown Display\", which is different from your previous screenshot (taken on \"Unknown Display (2)\"). Other attached monitors: \"Unknown Display (2)\". Use switch_display to capture a different monitor.", "after switch_display from display 1: \"different from your previous screenshot\"", text(s4));
  const s5 = await call("screenshot", {});
  ok(/^This screenshot was taken on monitor "Unknown Display"\. Other/.test(text(s5)), "previous display 0: the plain note again", text(s5));

  // Upstream's own note function, cut from the extract, on the same input.
  const chunks = existsSync(BUILD_DIR) ? readdirSync(BUILD_DIR).filter((f) => /^index.*\.js$/.test(f)) : [];
  let src = null;
  for (const c of chunks) { const t = readFileSync(path.join(BUILD_DIR, c), "utf8"); if (t.includes("This screenshot was taken on monitor")) { src = t; break; } }
  if (!src) console.log("  SKIP upstream's note: no extract");
  else {
    const at = src.indexOf("This screenshot was taken on monitor");
    const head = src.lastIndexOf("async function ", at);
    const name = /^async function ([\w$]+)\(/.exec(src.slice(head))[1];
    const body = "async " + cutFn(src.slice(head), name);
    const names = /let a=([\w$]+)\(i\)/.exec(body);
    ok(!!names, "upstream's note builds its names with its naming function");
    // Its names come from the function [1] compared ours with; feed ours here.
    const upNote = new Function("NAMES", body.replace("async function " + name, "return async function").replace(names[1] + "(i)", "NAMES(i)"))(H.__dispNames);
    const ctx = { executor: { listDisplays: async () => VM }, logger: { warn() {} } };
    for (const [id, prev] of [[0, undefined], [1, 0], [1, 1], [0, 1], [1, undefined]]) {
      const u = await upNote(ctx, id, prev, true), o = H.__dispNote(VM, id, prev);
      ok((u ?? null) === o, `= upstream's note (shot on ${id}, previous ${prev})`, J(o));
    }
    const u1 = await upNote({ executor: { listDisplays: async () => [VM[0]] }, logger: { warn() {} } }, 0, undefined, true);
    ok(u1 === undefined && H.__dispNote([VM[0]], 0, undefined) === null, "= upstream: one monitor, no note");
  }
}

// ── [4] accessibility tools ────────────────────────────────────────────────
console.log("\n[4] accessibility tools: the same names");
{
  stub(VM);
  let opts = null;
  globalThis.__cdbAxHandles = (t) => t === "app_ax_find";
  globalThis.__cdbAxCall = async (t, i, o) => { opts = o; return { content: [{ type: "text", text: "ok" }] }; };
  await call("app_ax_find", { window: "x" });
  delete globalThis.__cdbAxHandles; delete globalThis.__cdbAxCall;
  ok(opts && typeof opts.dname === "function" && (await opts.dname(1)) === "Unknown Display (2)" && (await opts.dname(0)) === "Unknown Display", "opts.dname names the window's display as the screenshot note does");
  const AX = readFileSync(path.join(ROOT, "js", "cu_ax_tools.js"), "utf8");
  ok(/\("\+\(dn\|\|f\.label\|\|"display "\+f\.displayId\)\+"\), now the current display"/.test(AX), "cu_ax_tools.js uses it in its \"now the current display\" note");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
