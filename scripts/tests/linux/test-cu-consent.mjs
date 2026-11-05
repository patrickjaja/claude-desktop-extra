#!/usr/bin/env node
// Computer Use on Linux: "Ask before Computer Use controls an app".
//
// WHY THIS EXISTS
// ---------------
// Regular-mode Code sessions (x11 / wlroots / gnome / background display) used
// to answer request_access with synthetic full grants and run every tool on
// any app. With the switch on (the default), js/cu_handler_injection.js lets
// request_access and list_granted_applications run upstream's own
// handleToolCall (its approval card, its stored grants), and js/cu_consent.js
// checks every other tool against the session's grants with upstream's rules:
// nothing before a grant; the app under the pointer and the app in front where
// the session has a hit test, the app in front only where it has none;
// clipboard and system-key grant flags; masked screenshots where the executor
// masks, an unmasked screenshot plus a note where it cannot.
// fix_computer_use_linux.nim 6b makes upstream's grants full level, 6c lets
// its terminal / file-manager warnings see our canonical ids by their aliases.
//
// [1] js/cu_consent.js alone: mode, cache key, texts, grant matching, combos.
// [2] js/cu_handler_injection.js staged like sub-patch 6 around a fake
//     executor: switch off = the old behavior of this Code-session handler
//     path (upstream's own dispatch - teach, cloud Cowork - passes its
//     allowlist to the executor whatever the switch says; that is
//     test-cu-screenshot-mask.mjs); switch on = fall-through for the two
//     consent tools (any session, wired or not), gates per hitTest mode, the
//     held button (drag and drop), the screenshot / zoom ids (always passed),
//     the note keyed off the capture result, clipboard, open_application, the
//     accessibility tools' grant check, batches, kwin mode.
// [3] the compiled patch on the real extract: 6b / 6c applied once, and a
//     drifted anchor fails the build. SKIPs without binary or extract.
// [4] patches/Makefile lists every js/ file a patch staticRead's (a change to
//     an unlisted one leaves a stale binary).
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const INJECTION = join(ROOT, "js", "cu_handler_injection.js");
const CONSENT = join(ROOT, "js", "cu_consent.js");
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = join(process.env.CDB_BUNDLE_DIR || join(ROOT, "tmp", "app.asar.contents"), ".vite", "build");
const NONE_GRANTED = "No applications are granted for this session. Call request_access first.";

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { failures.push(msg); console.log("  FAIL " + msg); }
}
const text = (r) => (r && Array.isArray(r.content) ? r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "");

// --- the rig ---------------------------------------------------------------------
if (process.platform !== "linux") Object.defineProperty(process, "platform", { value: "linux" });
function loadConsent() {
  delete globalThis.__cdbCuConsent;
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(CONSENT, "utf8"))();
  return globalThis.__cdbCuConsent;
}
const FELL = { fellThrough: true };
const DISPATCHED = [];
function buildHandler() {
  let src = readFileSync(INJECTION, "utf8").trim();
  src = src.split("__SELF__").join("__self");
  src = src.split("__STATE__").join("__state");
  src = src.split("__MAKE_DISPATCH__").join("__dispatch()");
  src = src.split("__TOOL_NAME__").join("__tool");
  src = src.split("__INPUT__").join("__input");
  src = src.split("__SESSION__").join("__session");
  const gated = src.replace('if(process.platform==="linux"){', 'if(process.platform==="linux"&&!globalThis.__cuKwinMode){');
  if (gated === src) throw new Error("harness: the outer Linux gate line moved; update the rig");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("process", "__self", "__state", "__dispatch", "__tool", "__input", "__session", "__FELL", gated + "\nreturn __FELL;");
  const self = {};
  const dispatch = () => async (name, input) => { DISPATCHED.push(name); return { content: [{ type: "text", text: "upstream " + name }] }; };
  const h = (tool, input, session) => fn(process, self, {}, dispatch, tool, input || {}, session || {}, FELL);
  self.handleToolCall = (st, tool, input, session) => h(tool, input, session);
  return h;
}

// The fake executor: every action is recorded; front / under / caps are set per case.
const EX = {
  calls: [],
  caps: { screenshotFiltering: "mask", hitTest: "native", frontmost: "native", hostBundleId: "com.anthropic.Claude", backend: "x11-bridge" },
  front: null, under: {}, underCalls: 0,
  capabilitiesNow() { return Object.assign({ platform: "linux" }, this.caps); },
  __targetActive() { return true; },
  async getFrontmostApp() { return this.front; },
  async appUnderPoint(x, y) { this.underCalls++; const k = x + "," + y; return k in this.under ? this.under[k] : this.under["*"] === undefined ? null : this.under["*"]; },
  async click(x, y, b, n) { this.calls.push(["click", x, y, b, n]); },
  async type(t) { this.calls.push(["type", t]); },
  async key(k, r) { this.calls.push(["key", k, r]); },
  async holdKey(k) { this.calls.push(["holdKey", k]); },
  async scroll() { this.calls.push(["scroll"]); },
  async drag(a, b) { this.calls.push(["drag", a, b]); },
  async moveMouse(x, y) { this.calls.push(["move", x, y]); },
  async mouseDown() { this.calls.push(["down"]); },
  async mouseUp() { this.calls.push(["up"]); },
  async getCursorPosition() { return { x: 5, y: 6 }; },
  async listDisplays() { return [{ displayId: 0, isPrimary: true, width: 100, height: 100, originX: 0, originY: 0, label: "A" }]; },
  async capabilitiesAsync() { return this.capabilitiesNow(); },
  // Like the real executor: the result says what it did (masked / filtering).
  async screenshot(o) { this.calls.push(["screenshot", o]); const m = Array.isArray(o.allowedBundleIds) && this.caps.screenshotFiltering === "mask"; return { base64: "AAA", imgW: 100, imgH: 100, displayWidth: 100, displayHeight: 100, originX: 0, originY: 0, masked: m, filtering: m ? "mask" : "none" }; },
  async zoom(...a) { this.calls.push(["zoom", ...a]); const m = Array.isArray(a[1]) && this.caps.screenshotFiltering === "mask"; return { base64: "ZZZ", masked: m, filtering: m ? "mask" : "none" }; },
  resolveApp(n) { return { firefox: { bundleId: "org.mozilla.firefox", displayName: "Firefox" }, gedit: { bundleId: "org.gnome.gedit", displayName: "Text Editor" } }[String(n).toLowerCase()] || null; },
  async openApp(n) { this.calls.push(["openApp", n]); return { action: "opened" }; },
  async readClipboard() { this.calls.push(["readClipboard"]); return "clip"; },
  async writeClipboard(t) { this.calls.push(["writeClipboard", t]); }
};
globalThis.__linuxExecutor = EX;
globalThis.__cdbDiag = () => {};
// canonical ids: aliases fold to the .desktop id
globalThis.__cdbCuAppIds = {
  canon: (x) => ({ firefox: "org.mozilla.firefox", "firefox.desktop": "org.mozilla.firefox", gedit: "org.gnome.gedit" }[String(x).toLowerCase()] || x),
  hostId: () => "com.anthropic.Claude"
};
let ASK = true;
globalThis.__cdbCuAskBeforeControl = () => ASK;
const FF = { bundleId: "org.mozilla.firefox", displayName: "Firefox", tier: "full" };
const GEDIT = { bundleId: "org.gnome.gedit", displayName: "Text Editor" };
const HOST = { bundleId: "com.anthropic.Claude", displayName: "Claude" };
function session(grants, flags, extra) {
  return Object.assign({
    sessionId: "s-" + Math.random().toString(36).slice(2), sessionType: "ccd",
    onComputerUsePermissionRequest: async () => ({}), getCuAllowedApps: () => grants, getCuGrantFlags: () => flags || {}
  }, extra || {});
}
function resetEx(caps) {
  EX.calls = []; EX.front = null; EX.under = {}; EX.underCalls = 0;
  EX.caps = Object.assign({ screenshotFiltering: "mask", hitTest: "native", frontmost: "native", hostBundleId: "com.anthropic.Claude", backend: "x11-bridge" }, caps || {});
}

// --- [1] the module -----------------------------------------------------------------
console.log("\n[1] js/cu_consent.js");
const C = loadConsent();
{
  ASK = true; resetEx();
  ok(C.key() === "cu-ask:mask:native:native", "key on X11 with masking: " + C.key());
  resetEx({ screenshotFiltering: "none", hitTest: "none", frontmost: "native" });
  ok(C.key() === "cu-ask:none:none:native", "key on a session without hit test: " + C.key());
  ASK = false;
  ok(C.key() === "" && C.text("access") === "" && C.text("screenshot") === "", "switch off: empty key and texts (the patched sites keep their old text)");
  ASK = true; globalThis.__cuKwinMode = true;
  ok(C.key() === "" && C.active(session([FF])) === false, "kwin mode: inactive (upstream dispatches there)");
  delete globalThis.__cuKwinMode;
  ok(C.active(session([FF])) === true && C.active({ getCuAllowedApps: () => [] }) === true && C.active(null) === true,
    "O2: active for every Code session while on (the descriptions are shared by all sessions)");
  globalThis.__cdbCuAskBeforeControl = () => { throw new Error("x"); };
  ok(C.active(session([FF])) === true, "a throwing switch read counts as on (ask)");
  delete globalThis.__cdbCuAskBeforeControl;
  ok(C.active(session([FF])) === true, "no settings helper: on (the default)");
  globalThis.__cdbCuAskBeforeControl = () => ASK;
  resetEx();
  ok(/covered by solid rectangles/.test(C.text("screenshot")) && /approval card/.test(C.text("access")) &&
     /under the pointer/.test(C.text("input")) && /approved for this session/.test(C.text("openApp")), "mask + hit test texts");
  resetEx({ screenshotFiltering: "none", hitTest: "none", frontmost: "native" });
  ok(/not filtered/.test(C.text("screenshot")) && /including apps the user did not approve/.test(C.text("access")) &&
     /The app in front must be approved/.test(C.text("input")), "none + frontmost-only texts");
  resetEx({ screenshotFiltering: "none", hitTest: "none", frontmost: "none" });
  ok(/At least one app must be approved/.test(C.text("input")) && /under a point or in front/.test(C.text("access")), "no hit test, no frontmost texts");
  ok(!Object.values({ a: C.text("access"), i: C.text("input"), s: C.text("screenshot"), o: C.text("openApp"), p: C.text("prefix"), x: C.text("shotSuffix") }).some((t) => /—/.test(t)),
    "no em-dash in any text");
  resetEx({ screenshotMaskGaps: ["popups", "layer_shell_top_overlay"], backend: "wlroots-bridge" });
  ok(/popup menus, panels and overlays can still show/.test(C.text("screenshot")) && /popup menus, panels and overlays can still show/.test(C.text("access")) && /popups,layer_shell_top_overlay/.test(C.key()),
    "O3: the wlroots mask gaps are named in the screenshot and request_access texts and change the cache key: " + C.key());
  resetEx({ screenshotFiltering: "none", screenshotMaskGaps: ["popups"] });
  ok(!/popup/.test(C.text("screenshot")) && !/popups/.test(C.key()), "O3: no gap sentence where nothing is masked");
  resetEx();
  ok(C.grantFor("firefox", [FF]) === FF && C.grantFor("Firefox.desktop", [FF]) === FF && C.grantFor("org.mozilla.firefox", [FF]) === FF && C.grantFor("gedit", [FF]) === null,
    "grant matching by canonical id and alias");
  ok(C.grantFor("Mozilla Firefox", [{ bundleId: "org.mozilla.firefox", displayName: "Mozilla Firefox" }]) === null,
    "O1: a display name (or a window title) never matches a grant");
  ok(C.systemCombo("super+l") && C.systemCombo("Meta+L") && C.systemCombo("ctrl+alt+t") && C.systemCombo("alt+tab") && C.systemCombo("ctrl+alt+f3") &&
     !C.systemCombo("ctrl+c") && !C.systemCombo("Return") && C.systemCombo("ctrl+a super+l"), "system combos: upstream's Linux list, normalized");
  // R6: the spellings the bridges (key-spec grammar: case-insensitive, `_`
  // dropped, raw keysym names) and the ydotool path accept for the same keys.
  const SPELL = [
    ["Super_L", true], ["super_r", true], ["XK_Super_L", true], ["Meta_L+l", true], ["meta_r+L", true], ["Hyper_L", true], ["hyper+l", true],
    ["win+d", true], ["Super_L+Tab", true], ["ctrl+Super_L", true], ["leftmeta+l", true], ["SUPER+L", true], ["Super + l", true], ["super+l ", true],
    ["Control_L+Alt_L+Delete", true], ["ctrl_l+alt_r+BackSpace", true], ["LeftCtrl+LeftAlt+F2", true], ["Alt_L+F4", true], ["alt+F4", true],
    ["ctrl+alt+ delete", true], ["ctrl+alt +t", true], ["Super+Page_Up", true], ["super+Prior", true], ["shift+super+page_down", true], ["meta+KP_Enter", true],
    ["XF86PowerOff", true], ["XF86AudioMute", true], ["xf86_sleep", true], ["XF86LogOff", true], ["alt+SysRq+b", true], ["125", true], ["56+62", true],
    ["ctrl+é", true], ["meta", true], ["Super", true], ["alt+shift+tab", true], ["shift+alt+Tab", true], ["ctrl+Q", true],
    ["ctrl+c", false], ["ctrl+shift+t", false], ["Return", false], ["page_down", false], ["shift+Tab", false], ["ctrl+a", false], ["_", false], ["ctrl+_", false], ["F5", false], ["alt+f", false], ["a", false], ["", false]
  ];
  const wrong = SPELL.filter(([k, want]) => C.systemCombo(k) !== want).map(([k, want]) => k + " -> " + !want);
  ok(wrong.length === 0, "R6: system combos in every spelling (" + SPELL.length + " cases)" + (wrong.length ? ": wrong " + wrong.join("; ") : ""));
  ok(C.needsGrant(session([]), "screenshot") && C.needsGrant(session([]), "request_access") === null && C.needsGrant(session([FF]), "screenshot") === null,
    "needsGrant: refused before a grant except upstream's exemptions");
  ok(JSON.stringify(C.ids(session([FF, { bundleId: "com.anthropic.cu.screen", displayName: "Entire screen" }]))) === '["org.mozilla.firefox"]',
    "the screen pseudo-app is never an id");
}

// --- [2] the handler ----------------------------------------------------------------
console.log("\n[2] js/cu_handler_injection.js");
const H = buildHandler();
{
  // switch off: the old behavior of this Code-session handler path, byte for
  // byte. Upstream's own dispatch (teach, cloud Cowork) is NOT covered by this
  // claim: it passes its allowlist and is masked whatever the switch says
  // (test-cu-screenshot-mask.mjs), and 6b's full-level grants apply to it too.
  ASK = false; resetEx();
  let s = session([FF]);
  let r = await H("request_access", { apps: ["Firefox", "firefox"] }, s);
  ok(r !== FELL && /"granted":\[\{"bundleId":"Firefox"/.test(text(r)) && /"screenshotFiltering":"none"/.test(text(r)), "off: request_access answers the synthetic grants");
  r = await H("list_granted_applications", {}, s);
  ok(text(r) === "All applications are accessible on Linux (no grants needed)", "off: list_granted_applications old text");
  EX.under["*"] = GEDIT; EX.front = GEDIT;
  r = await H("left_click", { coordinate: [10, 10] }, session([]));
  ok(!r.isError && EX.calls.some((c) => c[0] === "click") && EX.underCalls === 0, "off: clicks without a gate, even with no grant");
  await H("screenshot", {}, s);
  const so = EX.calls.find((c) => c[0] === "screenshot");
  ok(so && so[1].allowedBundleIds === undefined, "off: screenshot unmasked (allowedBundleIds undefined)");
  await H("zoom", { region: [0, 0, 10, 10] }, s);
  const zo = EX.calls.find((c) => c[0] === "zoom");
  ok(zo && zo[2] === undefined && zo[5] && zo[5].globalCoords === true, "off: zoom unmasked, global coordinates");

  // switch on, a session without the card (O2): upstream's request_access
  // (its "not wired with a permission handler" refusal), nothing granted
  ASK = true; resetEx();
  r = await H("request_access", { apps: ["x"] }, { sessionId: "u", getCuAllowedApps: () => [] });
  ok(r === FELL, "O2: on, unwired session: request_access goes to upstream (no synthetic grants)");
  r = await H("left_click", { coordinate: [1, 1] }, { sessionId: "u" });
  ok(r.isError && text(r) === NONE_GRANTED && EX.calls.length === 0, "O2: on, unwired session: input refused, nothing granted");

  // switch on, wired
  resetEx(); s = session([]);
  ok((await H("request_access", { apps: ["Firefox"] }, s)) === FELL, "on: request_access runs upstream's handleToolCall (falls through)");
  ok((await H("list_granted_applications", {}, s)) === FELL, "on: list_granted_applications falls through");
  DISPATCHED.length = 0;
  r = await H("request_teach_access", { apps: ["Firefox"] }, s);
  ok(DISPATCHED[0] === "request_teach_access", "teach tools still go to upstream's dispatch");
  for (const t of ["screenshot", "left_click", "type", "wait", "cursor_position", "zoom"]) {
    r = await H(t, { coordinate: [1, 1], text: "x", region: [0, 0, 1, 1] }, s);
    ok(r.isError && text(r) === NONE_GRANTED && EX.calls.length === 0, "on, nothing granted: " + t + " refused with upstream's text");
  }

  // hit test (X11): pointer = front + under; keyboard = front
  resetEx(); s = session([FF]);
  EX.front = FF; EX.under["*"] = FF;
  r = await H("left_click", { coordinate: [10, 20] }, s);
  ok(!r.isError && EX.calls[0][0] === "click", "native: click on an approved app runs");
  EX.calls = []; EX.under["*"] = GEDIT;
  r = await H("left_click", { coordinate: [10, 20] }, s);
  ok(r.isError && /would land on "Text Editor"/.test(text(r)) && EX.calls.length === 0, "native: click on another app refused");
  EX.under = {};
  r = await H("double_click", { coordinate: [10, 20] }, s);
  ok(r.isError && /land on the desktop/.test(text(r)), "native: nothing under the point (desktop) refused");
  EX.front = GEDIT; EX.under["*"] = FF;
  r = await H("right_click", { coordinate: [10, 20] }, s);
  ok(r.isError && /"Text Editor" is not in the allowed applications and is currently in front/.test(text(r)), "native: another app in front refuses a click");
  EX.front = HOST; EX.calls = [];
  r = await H("left_click", { coordinate: [10, 20] }, s);
  ok(!r.isError && EX.calls.length === 1, "native: Claude in front does not block a click on an approved app");
  r = await H("type", { text: "hi" }, s);
  ok(r.isError && /Claude's own window still has keyboard focus/.test(text(r)), "Claude in front refuses typing");
  EX.front = FF; EX.calls = [];
  r = await H("type", { text: "hi" }, s);
  ok(!r.isError && EX.calls[0][0] === "type", "typing into the approved app in front runs");
  r = await H("key", { text: "super+l" }, s);
  ok(r.isError && /systemKeyCombos/.test(text(r)), "a system combo needs the systemKeyCombos flag");
  r = await H("key", { text: "super+l" }, session([FF], { systemKeyCombos: true }));
  ok(!r.isError, "and runs with it");
  r = await H("hold_key", { text: "alt+tab", duration: 0 }, s);
  ok(r.isError && /systemKeyCombos/.test(text(r)), "hold_key: same flag");
  EX.under = { "1,1": FF, "50,50": GEDIT }; EX.calls = [];
  r = await H("left_click_drag", { start_coordinate: [1, 1], coordinate: [50, 50] }, s);
  ok(r.isError && /Text Editor/.test(text(r)) && !EX.calls.some((c) => c[0] === "drag"), "a drag that ends on another app is refused");
  EX.under = { "5,6": GEDIT };
  r = await H("left_mouse_down", {}, s);
  ok(r.isError && /Text Editor/.test(text(r)), "mouse down checks the app under the cursor");
  EX.front = GEDIT;
  r = await H("mouse_move", { coordinate: [3, 3] }, s);
  ok(!r.isError, "mouse_move only needs a grant (upstream lets the pointer move anywhere)");

  // R1: drag and drop by hand (left_mouse_down, mouse_move, left_mouse_up):
  // while the button is held, a move is a drag checked at its target, and the
  // release is checked at the cursor - the button is released even when refused.
  resetEx(); s = session([FF]); EX.front = FF; globalThis.__cuMouseHeld = false;
  EX.under = { "5,6": FF, "50,50": GEDIT, "20,20": FF };
  r = await H("left_mouse_down", {}, s);
  ok(!r.isError && EX.calls.some((c) => c[0] === "down") && globalThis.__cuMouseHeld === true, "R1: mouse down on the approved app runs, the button is held");
  r = await H("left_mouse_down", {}, s);
  ok(r.isError && /already held/.test(text(r)) && EX.calls.filter((c) => c[0] === "down").length === 1, "R1: a second mouse down is refused (upstream's state check)");
  EX.calls = [];
  r = await H("mouse_move", { coordinate: [50, 50] }, s);
  ok(r.isError && /would land on "Text Editor"/.test(text(r)) && !EX.calls.some((c) => c[0] === "move"), "R1: held: a move onto another app is refused (no drag onto it)");
  r = await H("mouse_move", { coordinate: [20, 20] }, s);
  ok(!r.isError && EX.calls.some((c) => c[0] === "move"), "R1: held: a move within the approved app runs");
  EX.under["5,6"] = GEDIT; EX.calls = [];
  r = await H("left_mouse_up", {}, s);
  ok(r.isError && /Text Editor/.test(text(r)) && EX.calls.some((c) => c[0] === "up") && globalThis.__cuMouseHeld === false,
    "R1: release over another app is refused AND the button is released");
  EX.calls = [];
  r = await H("mouse_move", { coordinate: [50, 50] }, s);
  ok(!r.isError, "R1: after the release a move is free again");
  // scroll while held: checked at the point like any scroll
  EX.under["5,6"] = FF;
  await H("left_mouse_down", {}, s);
  r = await H("scroll", { coordinate: [50, 50] }, s);
  ok(r.isError && /Text Editor/.test(text(r)) && !EX.calls.some((c) => c[0] === "scroll"), "R1: held: a scroll onto another app is refused");
  // a click while held releases first (upstream), a drag clears the state
  EX.calls = [];
  r = await H("left_click", { coordinate: [20, 20] }, s);
  ok(!r.isError && EX.calls[0][0] === "up" && EX.calls[1][0] === "click" && globalThis.__cuMouseHeld === false, "R1: a click while held releases the button first");
  await H("left_mouse_down", {}, s); EX.calls = [];
  r = await H("left_click_drag", { start_coordinate: [20, 20], coordinate: [20, 20] }, s);
  ok(!r.isError && EX.calls[0][0] === "up" && EX.calls.some((c) => c[0] === "drag") && globalThis.__cuMouseHeld === false, "R1: a drag while held releases first and leaves the button up");
  // the cursor read failing on release: refused, but released
  await H("left_mouse_down", {}, s); EX.calls = [];
  const gcp = EX.getCursorPosition; EX.getCursorPosition = async () => { throw new Error("no pointer"); };
  r = await H("left_mouse_up", {}, s);
  EX.getCursorPosition = gcp;
  ok(r.isError && EX.calls.some((c) => c[0] === "up") && globalThis.__cuMouseHeld === false, "R1: a failed check on release still releases the button");
  // switch off: state tracked, nothing checked, no extra release
  ASK = false; EX.calls = []; EX.under["5,6"] = GEDIT;
  await H("left_mouse_down", {}, s);
  r = await H("mouse_move", { coordinate: [50, 50] }, s);
  ok(!r.isError && EX.calls.map((c) => c[0]).join(",") === "down,move", "R1: switch off: drag by hand unchecked, as before");
  await H("left_mouse_up", {}, s);
  ASK = true; globalThis.__cuMouseHeld = false;

  // R5: a failed frontmost read refuses; nothing focused (null) stays allowed
  resetEx(); s = session([FF]); EX.under["*"] = FF;
  const gf = EX.getFrontmostApp;
  EX.getFrontmostApp = async () => { const e = new Error("x11-bridge: cannot open display"); e.__cdbFront = true; throw e; };
  r = await H("type", { text: "hi" }, s);
  ok(r.isError && /Could not tell which app is in front/.test(text(r)) && !EX.calls.some((c) => c[0] === "type"), "R5: frontmost error refuses typing");
  r = await H("key", { text: "return" }, s);
  ok(r.isError && /Could not tell which app is in front/.test(text(r)), "R5: and keys");
  r = await H("left_click", { coordinate: [1, 1] }, s);
  ok(r.isError && /Could not tell/.test(text(r)) && !EX.calls.some((c) => c[0] === "click"), "R5: and clicks");
  EX.getFrontmostApp = gf; EX.front = null;
  r = await H("type", { text: "hi" }, s);
  ok(!r.isError, "R5: nothing focused (null) lets typing run, as upstream does");
  const gu = EX.appUnderPoint;
  EX.appUnderPoint = async () => { throw new Error("bridge died"); };
  r = await H("left_click", { coordinate: [1, 1] }, s);
  ok(r.isError && /Could not tell which app is at these coordinates/.test(text(r)), "hit test error refuses the click");
  EX.appUnderPoint = gu;

  // O1: an app whose window title / name is an approved app's is not it
  resetEx(); s = session([FF]);
  EX.front = { bundleId: "org.evil.spoof", displayName: "Firefox" }; EX.under["*"] = FF;
  r = await H("type", { text: "x" }, s);
  ok(r.isError && /currently in front/.test(text(r)), "O1: frontmost named \"Firefox\" but another id: refused");
  EX.front = FF; EX.under["*"] = { bundleId: "org.evil.spoof", displayName: "Firefox" };
  r = await H("left_click", { coordinate: [3, 3] }, s);
  ok(r.isError && /would land on/.test(text(r)), "O1: hit test on a window titled \"Firefox\" of another id: refused");
  // O6: with a hit test a click on Claude's own window is refused
  EX.under["*"] = HOST;
  r = await H("left_click", { coordinate: [3, 3] }, s);
  ok(r.isError && /the Claude window is at these coordinates/.test(text(r)), "O6: native hit test: a click on Claude's own window is refused");

  // no hit test: front only; Claude in front stands for the shared screen
  resetEx({ screenshotFiltering: "none", hitTest: "none", frontmost: "native" }); s = session([FF]);
  EX.front = FF; EX.under["*"] = GEDIT;
  r = await H("left_click", { coordinate: [10, 20] }, s);
  ok(!r.isError && EX.underCalls === 0, "none: no hit test, the approved app in front lets the click run");
  EX.front = GEDIT;
  r = await H("left_click", { coordinate: [10, 20] }, s);
  ok(r.isError && /currently in front/.test(text(r)), "none: another app in front refused");
  EX.front = HOST;
  r = await H("scroll", { coordinate: [10, 20] }, s);
  ok(!r.isError, "none: Claude in front = the shared screen, a pointer action runs");
  r = await H("type", { text: "x" }, s);
  ok(r.isError && /keyboard focus/.test(text(r)), "none: typing with Claude in front refused");
  EX.front = null;
  r = await H("type", { text: "x" }, s);
  ok(!r.isError, "none: front unknown (XWayland / fallback) lets it run");

  // screenshots and zoom
  resetEx(); s = session([FF]);
  r = await H("screenshot", {}, s);
  let shot = EX.calls.find((c) => c[0] === "screenshot");
  ok(JSON.stringify(shot[1].allowedBundleIds) === '["org.mozilla.firefox"]' && r.content.length === 1, "mask: the approved ids go to the executor, no note");
  await H("zoom", { region: [0, 0, 10, 10] }, s);
  let zoom = EX.calls.find((c) => c[0] === "zoom");
  ok(JSON.stringify(zoom[2]) === '["org.mozilla.firefox"]' && zoom[3] === null && zoom[5].globalCoords === true, "mask: zoom gets the ids and global coordinates");
  resetEx({ screenshotFiltering: "none", hitTest: "none" }); s = session([FF]);
  r = await H("screenshot", {}, s);
  shot = EX.calls.find((c) => c[0] === "screenshot");
  ok(JSON.stringify(shot[1].allowedBundleIds) === '["org.mozilla.firefox"]' && r.content.length === 2 && /not filtered.*Firefox/.test(r.content[1].text),
    "R2: a backend that cannot mask still gets the ids; its unmasked result brings the note (approved apps named)");
  r = await H("screenshot", {}, s);
  ok(r.content.length === 1, "the note comes once per session");
  if (typeof C.lockReleased === "function") C.lockReleased();
  r = await H("screenshot", {}, s);
  ok(r.content.length === 2, "and again after the lock was released (a new task)");

  // R2: the ids go to the executor however its capabilities read: a doctor
  // that failed (capabilitiesNow / capabilitiesAsync say "none") is the
  // executor's to refuse, never a reason to send no allowlist.
  resetEx({ screenshotFiltering: "none" }); s = session([FF]);
  EX.capabilitiesAsync = async function () { return Object.assign(this.capabilitiesNow(), { screenshotFiltering: "none" }); };
  let sent = null;
  const gs = EX.screenshot;
  EX.screenshot = async (o) => { sent = o; throw new Error("Screenshot not taken: could not check whether x11-bridge can hide the apps that are not allowed (x11-bridge doctor failed: timeout)."); };
  r = await H("screenshot", {}, s);
  ok(sent && JSON.stringify(sent.allowedBundleIds) === '["org.mozilla.firefox"]' && r.isError && /could not check whether x11-bridge can hide/.test(text(r)),
    "R2: doctor failure: the ids are still sent and the executor's refusal is returned (no unmasked capture)");
  EX.screenshot = gs;
  let zsent = null;
  const gz = EX.zoom;
  EX.zoom = async (...a) => { zsent = a; throw new Error("Screenshot not taken: x11-bridge could not hide the apps that are not allowed"); };
  r = await H("zoom", { region: [0, 0, 5, 5] }, s);
  ok(zsent && JSON.stringify(zsent[1]) === '["org.mozilla.firefox"]' && r.isError, "R2: zoom too");
  EX.zoom = gz;
  // the note follows the result, not a separate probe: capabilities say "mask"
  // but this capture came back unmasked -> note; and the other way round.
  resetEx(); s = session([FF]);
  EX.screenshot = async (o) => ({ base64: "A", imgW: 1, imgH: 1, displayWidth: 1, displayHeight: 1, originX: 0, originY: 0, masked: false, filtering: "none" });
  r = await H("screenshot", {}, s);
  ok(r.content.length === 2 && /not filtered/.test(r.content[1].text), "R2: an unmasked result brings the note even while capabilities said mask");
  resetEx({ screenshotFiltering: "none" }); s = session([FF]);
  EX.screenshot = async (o) => ({ base64: "A", imgW: 1, imgH: 1, displayWidth: 1, displayHeight: 1, originX: 0, originY: 0, masked: true, filtering: "mask" });
  r = await H("screenshot", {}, s);
  ok(r.content.length === 1, "R2: a masked result brings no note even while capabilities said none");
  EX.screenshot = gs;
  EX.capabilitiesAsync = async function () { return this.capabilitiesNow(); };
  // bounded: the note set is capped
  for (let i = 0; i < 300; i++) C.shotNote({ sessionId: "b" + i, getCuAllowedApps: () => [FF] }, { masked: false });
  ok(typeof C._notedSize === "function" && C._notedSize() <= 256, "the per-session note set is bounded: " + (C._notedSize ? C._notedSize() : "unbounded (no size)"));

  // clipboard, open_application
  resetEx(); s = session([FF]);
  r = await H("read_clipboard", {}, s);
  ok(r.isError && /clipboardRead/.test(text(r)) && !EX.calls.length, "read_clipboard needs clipboardRead");
  r = await H("write_clipboard", { text: "x" }, session([FF], { clipboardWrite: true }));
  ok(!r.isError && EX.calls[0][0] === "writeClipboard", "write_clipboard runs with clipboardWrite");
  r = await H("open_application", { app: "gedit" }, s);
  ok(r.isError && /not in the allowed applications/.test(text(r)) && !EX.calls.some((c) => c[0] === "openApp"), "open_application of an unapproved app refused");
  r = await H("open_application", { app: "firefox" }, s);
  ok(!r.isError && EX.calls.some((c) => c[0] === "openApp"), "open_application of an approved app (resolved to its id) runs");

  // accessibility tools get the grant check
  let axOpts = null;
  globalThis.__cdbAxHandles = (n) => n === "app_click";
  globalThis.__cdbAxCall = async (n, i, o) => { axOpts = o; return o.tier && o.tier(i.app) ? o.tier(i.app).error : { content: [{ type: "text", text: "ax ok" }] }; };
  r = await H("app_click", { app: "gedit" }, s);
  ok(r.isError && (axOpts.allowedApps || [])[0] === FF && axOpts.ctx === undefined, "R3: app_* tools: an unapproved app refused, the grants passed as allowedApps (never ctx: that is upstream's kwin context)");
  r = await H("app_click", { app: "Firefox" }, s);
  ok(text(r) === "ax ok", "app_* tools: an approved app runs");
  ASK = false;
  r = await H("app_click", { app: "gedit" }, s);
  ok(text(r) === "ax ok" && axOpts.tier === undefined, "app_* tools with the switch off: no grant check (as before)");
  ASK = true;
  delete globalThis.__cdbAxHandles; delete globalThis.__cdbAxCall;

  // batches: every sub-action is checked
  resetEx(); s = session([FF]); EX.front = FF; EX.under = { "1,1": FF, "2,2": GEDIT };
  r = await H("computer_batch", { actions: [{ action: "left_click", coordinate: [1, 1] }, { action: "left_click", coordinate: [2, 2] }, { action: "type", text: "x" }] }, s);
  ok(r.isError && EX.calls.filter((c) => c[0] === "click").length === 1 && !EX.calls.some((c) => c[0] === "type") && /Batch stopped at actions\[1\]/.test(text(r)),
    "a batch stops at the first refused sub-action");

  // kwin mode: the whole block is upstream's
  globalThis.__cuKwinMode = true;
  ok((await H("left_click", { coordinate: [1, 1] }, s)) === FELL, "kwin mode: falls through to upstream");
  delete globalThis.__cuKwinMode;
}

// --- [3] the patch on the real bundle ----------------------------------------------
let skipped = false;
let haveBin = true;
try { accessSync(PATCH_BIN, constants.X_OK); } catch { haveBin = false; }
if (!haveBin || !existsSync(join(BUILD_DIR, "index.js"))) {
  skipped = true;
  console.log("\n[3] SKIP: " + (haveBin ? "no extract under tmp/app.asar.contents/" : "patches/linux/fix_computer_use_linux is not compiled"));
} else {
  console.log("\n[3] fix_computer_use_linux 6b / 6c on the real extract");
  const scratch = mkdtempSync(join(tmpdir(), "cdb-cu-consent-"));
  try {
    let blob = readFileSync(join(BUILD_DIR, "index.js"), "utf8");
    for (const c of readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort()) {
      blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(join(BUILD_DIR, c), "utf8");
    }
    const staged = join(scratch, "staged.js");
    const run = (content) => { writeFileSync(staged, content); const r = spawnSync(PATCH_BIN, [staged], { encoding: "utf8" }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
    const r1 = run(blob);
    const patched = readFileSync(staged, "utf8");
    ok(r1.status === 0 && /\[OK\] 6b grant level/.test(r1.out) && /\[OK\] 6c sentinel predicate/.test(r1.out), "6b and 6c report [OK]");
    ok(patched.split('cuOnlyMode:process.platform==="linux"&&!globalThis.__cuKwinMode||process.env.COWORK_CU_ONLY!=="0"&&').length === 2,
      "6b: the context flag is full in regular mode, upstream's own term kept");
    ok(/function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(\2\)!==null\|\|process\.platform==="linux"&&\(globalThis\.__cdbCuAppIds\?\.aliasesOf\?\.\(\2\)\|\|\[\]\)\.some\(__cdbS=>\3\(__cdbS\)!==null\)\}/.test(patched),
      "6c: the sentinel predicate also tries the id's aliases");
    ok(patched.includes("globalThis.__cdbCuConsent={active:active,"), "Patch 1 embeds js/cu_consent.js");
    // The patched classifier + predicate, evaluated: an id whose alias is an
    // executable name is a sentinel; without aliases it is not.
    const pm = /__cdbS=>[\w$]+\(__cdbS\)!==null\)\}/.exec(patched);
    const end = pm ? pm.index + pm[0].length : -1;
    // The classifier's first helper (`function X(e){return e.toLowerCase().split(`),
    // the last one before the predicate; minified names change every release.
    let start = -1;
    if (end >= 0) for (const m of patched.slice(0, end).matchAll(/function [\w$]+\(([\w$]+)\)\{return \1\.toLowerCase\(\)\.split\(/g)) start = m.index;
    const fnName = pm ? /function ([\w$]+)\([\w$]+\)\{return [\w$]+\([\w$]+\)!==null\|\|process/.exec(patched.slice(start, end)) : null;
    ok(start > 0 && end - start < 20000 && !!fnName, "the classifier region before the predicate is extractable");
    if (start > 0 && fnName) {
      const vm = await import("node:vm");
      const sb = { process: { platform: "linux" }, globalThis: null };
      sb.globalThis = sb;
      sb.__cdbCuAppIds = { aliasesOf: (id) => ({ "org.gnome.Nautilus": ["org.gnome.Nautilus", "/usr/bin/nautilus"], "org.gnome.Ptyxis": ["ptyxis"] }[id] || []) };
      const S = vm.runInNewContext(patched.slice(start, end) + ";" + fnName[1], vm.createContext(sb));
      ok(S("org.gnome.Nautilus") === true && S("org.gnome.Ptyxis") === true && S("org.mozilla.firefox") === false && S("nautilus") === true,
        "aliases make Files and Ptyxis sentinels, Firefox stays not one");
      sb.process.platform = "darwin";
      ok(S("org.gnome.Nautilus") === false && S("com.apple.Terminal") === true, "off Linux: upstream's predicate unchanged");
    }
    const r2 = run(patched);
    ok(r2.status === 0 && readFileSync(staged, "utf8") === patched, "a second run changes nothing");
    const r3 = run(blob.replace('cuOnlyMode:process.env.COWORK_CU_ONLY!=="0"&&', 'cuOnlyMode:process.env.COWORK_CU_MODE!=="0"&&'));
    ok(r3.status !== 0 && /\[FAIL\] 6b cuOnlyMode context flag/.test(r3.out), "a moved cuOnlyMode flag fails the build");
    const r4 = run(blob.replace(/(return"system_settings"\}return null\}function [\w$]+\(([\w$]+)\)\{return )([\w$]+)\(\2\)!==null\}/, (_m, pre, v, cls) => pre + "!!" + cls + "(" + v + ")}"));
    ok(r4.status !== 0 && /\[FAIL\] 6c sentinel predicate/.test(r4.out), "a moved sentinel predicate fails the build");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- [4] patches/Makefile prerequisites ---------------------------------------------
console.log("\n[4] patches/Makefile lists every staticRead js/ file");
{
  const mk = readFileSync(join(ROOT, "patches", "Makefile"), "utf8").replace(/\\\n/g, " ");
  const rules = new Map();
  for (const line of mk.split("\n")) {
    const m = /^([\w/]+):\s*(.*)$/.exec(line);
    if (m && !line.startsWith("%")) rules.set(m[1], (rules.get(m[1]) || "") + " " + m[2]);
  }
  const missing = [];
  for (const dir of ["linux", "community", "core"]) {
    for (const f of readdirSync(join(ROOT, "patches", dir)).filter((x) => x.endsWith(".nim"))) {
      const src = readFileSync(join(ROOT, "patches", dir, f), "utf8");
      const target = dir + "/" + f.replace(/\.nim$/, "");
      for (const m of src.matchAll(/staticRead\("\.\.\/\.\.\/js\/([^"]+)"\)/g)) {
        const deps = (rules.get(target) || "").split(/\s+/);
        if (!deps.includes("../js/" + m[1])) missing.push(target + " <- js/" + m[1]);
      }
    }
  }
  ok(missing.length === 0, "R4: every embedded js/ file is a prerequisite of its binary" + (missing.length ? ": missing " + missing.join(", ") : ""));
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) { console.log(`${pass} checks passed; real-bundle section SKIPPED`); process.exit(3); }
console.log("ALL " + pass + " CHECKS PASSED");
