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
// [3b] per-app truth (16a-16d): upstream's patched prompt-suffix function, its
//     patched computerUsePerAppAccess entry and its patched "Entire screen"
//     pseudo-grant, cut from the patched chunks and run in vm with the real
//     js/cu_consent.js over one stub backend per row of the spec's table
//     (kwin, x11 mask + hit test, sway mask with gaps, background display,
//     niri / GNOME / fallback without a mask, the switch off; Wayland and X11
//     hosts), the suffix's consumer in another chunk, and the features
//     re-signal (16c).
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

// --- [3b] per-app truth on the patched chunks ---------------------------------------
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(b) {
  const pieces = b.split(SPLIT_RE);
  const names = ["index.js"], bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) { names.push(pieces[i]); bodies.push(pieces[i + 1]); }
  return { names, bodies, get: (n) => bodies[names.indexOf(n)] };
}
const escRe = (x) => x.replace(/[$.\-]/g, "\\$&");
// `function NAME(...){...}` by brace matching (template text without braces).
function fnSource(body, name) {
  const at = body.indexOf("function " + name + "(");
  if (at < 0) return null;
  let d = 0;
  for (let i = body.indexOf("{", at); i < body.length; i++) {
    if (body[i] === "{") d++;
    else if (body[i] === "}" && --d === 0) return body.slice(at, i + 1);
  }
  return null;
}
function exportOf(body, alias) {
  const all = [...body.matchAll(new RegExp('Object\\.defineProperty\\(exports,"' + escRe(alias) + '",\\{enumerable:!0,get:function\\(\\)\\{return ([\\w$]+)\\}\\}\\)', "g"))];
  return all.length === 1 ? all[0][1] : null;
}
function aliasesOf(body, local) {
  return [...body.matchAll(new RegExp('Object\\.defineProperty\\(exports,"([\\w$]+)",\\{enumerable:!0,get:function\\(\\)\\{return ' + escRe(local) + "\\}\\}\\)", "g"))].map((m) => m[1]);
}
// The real js/cu_linux_executor.js on an X11 session with an x11-bridge that
// masks (stubbed child_process / electron / fs; one display, two windows).
async function realX11Executor() {
  const pathM = await import("node:path"), osM = await import("node:os");
  const saved = { env: { ...process.env }, keys: new Set(Object.keys(globalThis)), ex: globalThis.__linuxExecutor, ids: globalThis.__cdbCuAppIds, diag: globalThis.__cdbDiag };
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "WAYLAND_DISPLAY", "CHROME_DESKTOP"]) delete process.env[k];
  Object.assign(process.env, { XDG_CURRENT_DESKTOP: "XFCE", XDG_SESSION_TYPE: "x11", DISPLAY: ":0", PATH: "/usr/bin:/bin" });
  const R = (x, y, width, height) => ({ x, y, width, height });
  const win = (id, cls, name, g) => ({ id: String(id), title: name, geometry: g, pid: 2000 + id, desktop_file_name: null, resource_class: cls, resource_name: name, output: null, window_type: "normal", is_dock: false, is_desktop: false, is_visible: true, is_minimized: false, is_normal_window: true, stacking_order: id });
  const wins = [win(1, "firefox", "firefox", R(0, 0, 960, 1080)), win(2, "Gedit", "gedit", R(960, 0, 960, 1080))];
  const rig = { calls: [], under: null };
  const reply = (args) => {
    const sub = args[0];
    if (sub === "doctor") return JSON.stringify({ contract: 1, bridge: "x11-bridge", capabilities: { screenshot_mask: true } });
    if (sub === "screens") return JSON.stringify([{ id: "screen", name: "screen", geometry: R(0, 0, 1920, 1080), scale: 1, is_primary: true }]);
    if (sub === "windows") return JSON.stringify(wins);
    if (sub === "frontmost-app") return JSON.stringify({ bundleId: "firefox", displayName: "Firefox" });
    if (sub === "app-under-point") return JSON.stringify(rig.under);
    if (sub === "zoom" || sub === "screenshot") {
      const keep = []; for (let i = 0; i < args.length; i++) if (args[i] === "--keep-window") keep.push(args[i + 1]);
      return JSON.stringify({ base64: "MASKED", width: 1920, height: 1080, mask: { mode: args.includes("--mask-all") ? "all" : "keep", fill: "#1E1E1E", kept: keep, kept_hidden: [], kept_missing: [], auto_kept: [], masked: wins.filter((w) => !keep.includes(w.id)).map((w) => ({ id: w.id, frame: w.id, pid: w.pid, desktop_file_name: null, resource_class: w.resource_class, resource_name: w.resource_name, override_redirect: false })) } });
    }
    return "{}";
  };
  const cp = {
    execFileSync(bin, args) { const b = pathM.basename(String(bin)); if (b === "systemd-detect-virt") return "none\n"; if (b !== "x11-bridge") throw new Error("not found: " + b); rig.calls.push({ b, args, sync: true }); return reply(args); },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) { const b = pathM.basename(String(bin)); if (b !== "x11-bridge") { setTimeout(() => cb(new Error("not found"), "", ""), 0); return; } rig.calls.push({ b, args }); setTimeout(() => cb(null, reply(args), ""), 0); },
    spawn() { return { on() {}, unref() {} }; },
  };
  const d = { id: 1, label: "Screen", bounds: R(0, 0, 1920, 1080), size: { width: 1920, height: 1080 }, workArea: R(0, 0, 1920, 1080), scaleFactor: 1, nativeOrigin: { x: 0, y: 0 } };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => "/ud" },
    screen: { getAllDisplays: () => [d], getPrimaryDisplay: () => d, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => [] }, clipboard: { readText: () => "", writeText: () => {} }, nativeImage: {},
  };
  const fsStub = { constants: { X_OK: 1 }, readFileSync: () => Buffer.alloc(0), writeFileSync() {}, unlinkSync() {}, existsSync: () => false, renameSync() {}, accessSync() { throw new Error("ENOENT"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), readlinkSync() { throw new Error("no"); }, realpathSync: (p) => p, promises: { stat: async () => { throw new Error("ENOENT"); } } };
  const req = (id) => ({ child_process: cp, electron, path: pathM.default || pathM, os: osM.default || osM, fs: fsStub })[id] || (() => { throw new Error("unexpected require " + id); })();
  globalThis.__cdbDiag = () => {};
  delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin; delete globalThis.__cuTargetRead; delete globalThis.__cuTargetSig; delete globalThis.__cuBridgeFail;
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  globalThis.__cuKwinMode = false;
  new Function("process", readFileSync(join(ROOT, "js", "cu_display_target.js"), "utf8"))(process);
  new Function("require", "process", readFileSync(join(ROOT, "js", "cu_linux_executor.js"), "utf8"))(req, process);
  rig.ex = globalThis.__linuxExecutor;
  rig.restore = () => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    for (const k of Object.keys(globalThis)) if (!saved.keys.has(k)) delete globalThis[k];
    globalThis.__linuxExecutor = saved.ex; globalThis.__cdbCuAppIds = saved.ids; globalThis.__cdbDiag = saved.diag;
  };
  return rig;
}
const SCREEN_ID = "com.anthropic.cu.screen";
async function perAppTruth(patched, pristineBlob) {
  const vm = await import("node:vm");
  const P = splitParts(patched);
  // --- the three patched sites, cut from their chunks
  const SUFFIX_RE = /function ([\w$]+)\(\)\{if\(process\.platform==="linux"\)\{let __cdbSpx;try\{__cdbSpx=globalThis\.__cdbCuConsent\?\.spSuffix\?\.\(\)\}catch\(__cdbSpe\)\{\}if\(typeof __cdbSpx==="string"\)return __cdbSpx\}return ([\w$]+)\.([\w$]+)\(\)\?/;
  const sIdx = P.bodies.findIndex((b) => SUFFIX_RE.test(b));
  ok(sIdx >= 0 && patched.match(new RegExp(SUFFIX_RE.source, "g")).length === 1, "16a: the patched suffix function is in the bundle once");
  if (sIdx < 0) return;
  const sb = P.bodies[sIdx], sm = SUFFIX_RE.exec(sb);
  const suffixSrc = fnSource(sb, sm[1]);
  const upstreamText = /\?(`[^`]*`):""\}$/.exec(suffixSrc);
  ok(!!upstreamText && /whole shared screen/.test(upstreamText[1]) && /dialogs is open/.test(upstreamText[1]), "16a: upstream's own text stays as the fallback (" + sm[1] + ")");
  // Its consumers: local calls in its chunk, and `X.<alias>()` in chunks that require it.
  // Calls in its own chunk, the definition left out: computer_use, cu_only, request_access.
  const localCalls = [...sb.matchAll(new RegExp("(?<![\\w$.])" + escRe(sm[1]) + "\\(\\)", "g"))].filter((m) => sb.slice(Math.max(0, m.index - 9), m.index) !== "function ").length;
  ok(localCalls === 3, "16a: the suffix is called 3 times in its own chunk (computer_use / cu_only / request_access): " + localCalls);
  const aliases = aliasesOf(sb, sm[1]);
  let outside = 0;
  P.bodies.forEach((b, i) => {
    if (i === sIdx) return;
    for (const r of b.matchAll(new RegExp('(?<![\\w$.])([\\w$]+)=require\\("\\./' + escRe(P.names[sIdx]) + '"\\)', "g")))
      for (const a of aliases) {
        const n = b.split(r[1] + "." + a + "()").length - 1;
        if (n) { outside += n; console.log("    (" + P.names[i] + ": " + r[1] + "." + a + "() -> " + P.names[sIdx] + " exports." + a + " = " + exportOf(sb, a) + ")"); }
      }
  });
  ok(outside >= 1 && aliases.every((a) => exportOf(sb, a) === sm[1]), "16a: the other chunk's consumer (canUseTool deny message) resolves to the patched function");

  const PA_RE = /computerUsePerAppAccess:(\(process\.platform==="linux"&&typeof globalThis\.__cdbCuSharedScreen==="function"\?globalThis\.__cdbCuSharedScreen\(\):([\w$]+)\(\)\)\?(\{status:"unsupported",reason:"[^"]*",unsupportedCode:"[^"]*"\}):([\w$]+)),/;
  const pIdx = P.bodies.findIndex((b) => PA_RE.test(b));
  ok(pIdx >= 0, "16b: the patched computerUsePerAppAccess entry is in the bundle");
  if (pIdx < 0) return;
  const pm = PA_RE.exec(P.bodies[pIdx]);
  const paExpr = pm[1], paWl = pm[2], paSupported = pm[4];

  const YE_RE = /function ([\w$]+)\(([\w$]+),[\w$]+\)\{if\(process\.platform==="linux"&&globalThis\.__cdbCuNoScreenGrant\?\.\(\)===!0\|\|([\w$]+)\.([\w$]+)!==\3\.([\w$]+)\|\|/;
  const yIdx = P.bodies.findIndex((b) => YE_RE.test(b));
  ok(yIdx >= 0, "16d: the patched pseudo-grant function is in the bundle");
  if (yIdx < 0) return;
  const ym = YE_RE.exec(P.bodies[yIdx]);
  const yeSrc = fnSource(P.bodies[yIdx], ym[1]);
  // The helper namespace the pseudo-grant reads tiers from (`n.l(...).explicitGrants`, `n.u[tier]`).
  const yeNs = /new ([\w$]+)\.([\w$]+)\(/.exec(yeSrc);

  // 16e: both enable-prompt approval cards (session server, local agent canUseTool).
  const CARD_RE = /screenshotFiltering:(\(process\.platform==="linux"&&globalThis\.__cdbCuSharedScreen\?\.\(\)===!1\?globalThis\.__linuxExecutor\?\.capabilities\?\.screenshotFiltering\?\?"mask":([\w$]+)\.([\w$]+)\.screenshotFiltering\)),(?:hostPlatform:[\w$]+\.[\w$]+\.platform,)?featureDisabled:!0/g;
  const cards = [];
  P.bodies.forEach((b, i) => { for (const m of b.matchAll(CARD_RE)) cards.push({ part: P.names[i], expr: m[1], ns: m[2], key: m[3] }); });
  ok(cards.length === 2 && new Set(cards.map((c) => c.part)).size === 2, "16e: both enable cards patched, one per chunk: " + cards.map((c) => c.part).join(", "));

  // --- one sandbox per row: real js/cu_consent.js, a stub executor
  const consentSrc = readFileSync(CONSENT, "utf8");
  function rowCtx(row) {
    const ctx = { console };
    ctx.globalThis = ctx;
    ctx.process = { platform: row.platform || "linux", env: row.host === "x11" ? { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" } : { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" } };
    ctx.__cdbDiag = (m) => (ctx.diag = (ctx.diag || []).concat(String(m)));
    if (row.kwin) ctx.__cuKwinMode = true;
    ctx.__cdbCuAskBeforeControl = () => row.ask !== false;
    const caps = row.caps || {};
    ctx.nowCalls = 0;
    ctx.__linuxExecutor = {
      // The live getter upstream reads (exec-free); capabilitiesNow() may run pgrep.
      capabilities: { get screenshotFiltering() { return caps.screenshotFiltering || "none"; }, platform: "linux", hostBundleId: "com.anthropic.Claude" },
      capabilitiesNow() { ctx.nowCalls++; return Object.assign({ platform: "linux", hostBundleId: "com.anthropic.Claude", screenshotMaskGaps: [] }, caps); },
    };
    vm.createContext(ctx);
    if (!row.noConsent && (row.platform || "linux") === "linux") vm.runInContext(consentSrc, ctx);
    const wayland = row.host !== "x11";
    const ns = (n) => (ctx[n] = ctx[n] || {});
    ns(sm[2])[sm[3]] = () => wayland;
    ctx[paWl] = () => wayland;
    ctx[paSupported] = { status: "supported" };
    // PLATFORM_CAPABILITIES is the Wayland preset on a Wayland host (2b: X11 gets its own object).
    const WL = { screenshotFiltering: "none", platform: "linux", hitTest: "none" };
    Object.assign(ns(ym[3]), { [ym[4]]: wayland ? WL : { screenshotFiltering: "none", platform: "linux" }, [ym[5]]: WL });
    ns(ym[3])[/\{bundleId:([\w$]+)\.([\w$]+),displayName:"Entire screen"/.exec(yeSrc)[2]] = SCREEN_ID;
    if (yeNs) Object.assign(ns(yeNs[1]), { [yeNs[2]]: class { constructor(e) { this.explicitGrants = e; } }, u: { read: 0, click: 1, full: 2 } });
    for (const c of cards) ns(c.ns)[c.key] = ns(ym[3])[ym[4]];
    vm.runInContext(suffixSrc + ";" + yeSrc, ctx);
    return {
      ctx,
      suffix: () => vm.runInContext(sm[1] + "()", ctx),
      perApp: () => vm.runInContext("(" + paExpr + ")", ctx),
      cards: () => cards.map((c) => vm.runInContext(c.expr, ctx)),
      pseudo: () => vm.runInContext(ym[1] + "([{bundleId:'org.mozilla.firefox',displayName:'Firefox',tier:'click',grantedAt:1},{bundleId:'foot',displayName:'foot',tier:'full',grantedAt:2}],[])", ctx).some((a) => a.bundleId === SCREEN_ID),
    };
  }
  const MASK = { screenshotFiltering: "mask", hitTest: "native", frontmost: "native" };
  const ROWS = [
    // label, row, want {suffix: "" | "mask" | "none" | "off", perApp, pseudo}
    ["kwin-portal-bridge (kwin mode)", { kwin: true, caps: { screenshotFiltering: "native" } }, { suffix: "", perApp: "supported", pseudo: false, card: "native" }],
    ["kwin mode, ask switch off", { kwin: true, ask: false, caps: { screenshotFiltering: "native" } }, { suffix: "", perApp: "supported", pseudo: false, card: "native" }],
    ["x11-bridge on X11 (mask + hit test)", { host: "x11", caps: { ...MASK, backend: "x11-bridge" } }, { suffix: "mask", hit: "native", perApp: "supported", pseudo: false, card: "mask" }],
    ["wlroots-bridge on sway (mask with gaps)", { caps: { ...MASK, screenshotMaskGaps: ["popups", "layer_shell_top_overlay"], backend: "wlroots-bridge" } }, { suffix: "mask", hit: "native", gaps: true, perApp: "supported", pseudo: false, card: "mask" }],
    ["background display x11 on Wayland", { caps: { ...MASK, backend: "x11-bridge (background display :99)" } }, { suffix: "mask", hit: "native", perApp: "supported", pseudo: false, card: "mask" }],
    ["background display wlroots on Wayland", { caps: { ...MASK, backend: "wlroots-bridge (background display wayland-9)" } }, { suffix: "mask", hit: "native", perApp: "supported", pseudo: false, card: "mask" }],
    ["wlroots-bridge on niri (no mask)", { caps: { screenshotFiltering: "none", hitTest: "none", frontmost: "native", backend: "wlroots-bridge" } }, { suffix: "none", hit: "frontmost", perApp: "unsupported", pseudo: false, card: "none" }],
    ["gnome-portal-bridge", { caps: { screenshotFiltering: "none", hitTest: "none", frontmost: "native", backend: "gnome-portal-bridge" } }, { suffix: "none", hit: "frontmost", perApp: "unsupported", pseudo: false, card: "none" }],
    ["fallback tools on Wayland", { caps: { screenshotFiltering: "none", hitTest: "none", frontmost: "none", backend: "none" } }, { suffix: "none", hit: "none", perApp: "unsupported", pseudo: false, card: "none" }],
    ["fallback tools on X11 (no bridge)", { host: "x11", caps: { screenshotFiltering: "none", hitTest: "none", frontmost: "none", backend: "none" } }, { suffix: "none", hit: "none", perApp: "unsupported", pseudo: false, card: "none" }],
    ["ask switch off, sway mask-capable", { ask: false, caps: { ...MASK, backend: "wlroots-bridge" } }, { suffix: "off", perApp: "unsupported", pseudo: true, card: "none" }],
    ["ask switch off, x11-bridge on X11", { host: "x11", ask: false, caps: { ...MASK, backend: "x11-bridge" } }, { suffix: "off", perApp: "unsupported", pseudo: false, card: "none" }],
  ];
  for (const [label, row, w] of ROWS) {
    const r = rowCtx(row);
    const s = r.suffix();
    if (w.suffix === "") ok(s === "", label + ": suffix empty (upstream's per-app rules hold)");
    else {
      ok(typeof s === "string" && s.startsWith("\n\nOn this system (Linux)"), label + ": our suffix, not upstream's: " + JSON.stringify(s.slice(0, 60)));
      ok(!/Linux Wayland session|whole shared screen at once|most permissive tier/.test(s), label + ": none of upstream's shared-screen claims");
    }
    ok(!/dialog/i.test(s), label + ": never claims the dialog refusal");
    if (w.suffix === "mask") {
      ok(!/whole screen|show everything|not filtered/.test(s) && /Screenshots show only the approved apps' windows/.test(s), label + ": masked - never says screenshots show everything");
      ok(/granted at tier "full"/.test(s), label + ": every approved app at tier full");
    }
    if (w.suffix === "none" || w.suffix === "off") ok(/show the whole screen/.test(s), label + ": unmasked - says screenshots show the whole screen");
    if (w.suffix === "off") ok(/not checked/.test(s) && /Act only in the apps the user asked for/.test(s), label + ": switch off - apps not checked, act only in the asked-for apps");
    if (w.hit === "native") ok(/Clicks, scrolls and drags on a window of an app that is not approved are refused/.test(s), label + ": hit-test input sentence");
    if (w.hit === "frontmost") ok(/cannot tell which window is under a point: clicks and keystrokes go to whatever is there, and they are refused while an app that is not approved is in front/.test(s), label + ": frontmost-only input sentence");
    if (w.hit === "none") ok(/cannot tell which window is under a point or in front/.test(s), label + ": no-input-check sentence");
    if (w.suffix === "mask") ok(w.gaps ? /popup menus, panels and overlays can still show/.test(s) : !/covering is approximate/.test(s), label + ": mask gaps " + (w.gaps ? "stated" : "absent"));
    const pa = r.perApp();
    ok((pa && pa.status) === w.perApp, label + ": computerUsePerAppAccess " + w.perApp + " (got " + JSON.stringify(pa) + ")");
    if (w.perApp === "unsupported") ok(pa.reason === "A Wayland session shares the whole screen", label + ": upstream's reason kept");
    ok(r.pseudo() === w.pseudo, label + ": \"Entire screen\" pseudo-grant " + (w.pseudo ? "added" : "left out"));
    ok(JSON.stringify(r.cards()) === JSON.stringify([w.card, w.card]), label + ": enable cards show screenshotFiltering " + w.card + (w.card === "none" ? " (upstream's whole-screen warning)" : " (no whole-screen warning)") + ", got " + JSON.stringify(r.cards()));
    const before = r.ctx.nowCalls;
    r.perApp(); r.pseudo();
    ok(r.ctx.nowCalls === before, label + ": per-app answer never calls capabilitiesNow() (exec-free)");
    if (!row.kwin) ok((r.ctx.diag || []).some((l) => l.startsWith("[claude-cu] prompt suffix: ")), label + ": the suffix hook logged on entry");
  }
  // The REAL executor (x11-bridge on X11, the rig of test-cu-screenshot-mask.mjs
  // trimmed): what the suffix promises is what the executor and the gate do.
  {
    const real = await realX11Executor();
    try {
      const caps = await real.ex.capabilitiesAsync();
      ok(caps.screenshotFiltering === "mask" && caps.hitTest === "native", "real executor: x11-bridge doctor answers mask, hit test native", JSON.stringify(caps));
      const r = rowCtx({ host: "x11" });
      r.ctx.__linuxExecutor = real.ex;
      r.ctx.__cdbCuAppIds = globalThis.__cdbCuAppIds;
      const s = r.suffix();
      ok(/Screenshots show only the approved apps' windows/.test(s) && /Clicks, scrolls and drags on a window of an app that is not approved are refused/.test(s), "real executor: suffix promises masked screenshots and a hit test");
      ok(r.perApp().status === "supported" && JSON.stringify(r.cards()) === '["mask","mask"]' && r.pseudo() === false, "real executor: per-app supported, cards 'mask', no pseudo-grant");
      const C = r.ctx.__cdbCuConsent;
      const sess = { sessionId: "real-1", getCuAllowedApps: () => [{ bundleId: "firefox", displayName: "Firefox", tier: "full" }], getCuGrantFlags: () => ({}) };
      real.under = { bundleId: "gedit", displayName: "Text Editor" };
      const refused = await C.gate(sess, "pointer", [[200, 200]]);
      ok(refused && refused.isError && /would land on "Text Editor"/.test(refused.content[0].text), "real executor: a click on an unapproved window is refused (the sentence holds)", JSON.stringify(refused));
      real.under = { bundleId: "firefox", displayName: "Firefox" };
      ok((await C.gate(sess, "pointer", [[200, 200]])) === null, "real executor: a click on the approved app passes");
      real.calls.length = 0;
      const shot = await real.ex.screenshot({ allowedBundleIds: C.shotIds(sess) });
      const z = real.calls.find((c) => c.args[0] === "zoom" || c.args[0] === "screenshot");
      ok(shot && shot.masked === true && !!z && z.args.includes("--keep-window"), "real executor: the screenshot is masked to the approved app's windows", JSON.stringify(z && z.args));
    } finally {
      real.restore();
    }
  }
  // Off Linux and without js/cu_consent.js: upstream's answers.
  {
    const r = rowCtx({ platform: "darwin", host: "x11" });
    ok(r.suffix() === "" && r.perApp().status === "supported" && r.pseudo() === false && r.cards().every((v) => v === "none"), "darwin: upstream's answers (no suffix, supported, no pseudo-grant, preset card)");
    const r2 = rowCtx({ noConsent: true });
    ok(r2.suffix() === JSON.parse(JSON.stringify(vm.runInNewContext(upstreamText[1]))) && r2.perApp().status === "unsupported" && r2.pseudo() === true && r2.cards().every((v) => v === "none"), "Linux Wayland without js/cu_consent.js: upstream's text, unsupported, pseudo-grant, preset card");
    const r3 = rowCtx({ caps: { ...MASK } });
    r3.ctx.__cdbCuConsent.spSuffix = () => { throw new Error("boom"); };
    ok(r3.suffix() === vm.runInNewContext(upstreamText[1]), "16a: a throwing spSuffix() falls back to upstream's text");
  }
  // The pristine bundle: upstream's text on Wayland, per-app unsupported - the old code fails the rows above.
  ok(!pristineBlob.includes("__cdbCuSharedScreen") && !pristineBlob.includes("spSuffix"), "pristine bundle carries none of 16a / 16b / 16d");

  // --- 16c: the captured broadcast is upstream's subscriber loop, and a change re-signals once
  const FC_RE = /function ([\w$]+)\(\)\{for\(let ([\w$]+) of ([\w$]+)\)\2\(\)\}process\.platform==="linux"&&\(globalThis\.__cdbCuFeaturesChanged=\1\);function ([\w$]+)\(([\w$]+)\)\{if\(\3\.add\(\5\),/;
  const fIdx = P.bodies.findIndex((b) => FC_RE.test(b));
  ok(fIdx >= 0, "16c: __cdbCuFeaturesChanged is the loop over the set onSupportedFeaturesInputsChanged adds to");
  if (fIdx >= 0) {
    const fm = FC_RE.exec(P.bodies[fIdx]);
    ok(new RegExp("onSupportedFeaturesInputsChanged:\\(\\)=>" + escRe(fm[4]) + "[,}]").test(P.bodies[fIdx]), "16c: " + fm[4] + " is onSupportedFeaturesInputsChanged");
    const c = { process: { platform: "linux" }, hits: 0 };
    c.globalThis = c;
    vm.createContext(c);
    vm.runInContext("var " + fm[3] + "=new Set([()=>globalThis.hits++,()=>globalThis.hits++]);" + fnSource(P.bodies[fIdx], fm[1]) + ";process.platform===\"linux\"&&(globalThis.__cdbCuFeaturesChanged=" + fm[1] + ");globalThis.__cdbCuFeaturesChanged()", c);
    ok(c.hits === 2, "16c: calling it notifies every subscriber (every window re-fetches)");
  }
  {
    const r = rowCtx({ caps: { screenshotFiltering: "none", hitTest: "native", frontmost: "native" } });
    let sig = 0;
    r.ctx.__cdbCuFeaturesChanged = () => sig++;
    const C = r.ctx.__cdbCuConsent;
    ok(C.capChanged("doctor answered") === false && sig === 0, "re-signal: nothing before the renderer's first read");
    ok(r.perApp().status === "unsupported", "re-signal: first read before the doctor answered = unsupported");
    r.ctx.__linuxExecutor.capabilities = { screenshotFiltering: "mask" };
    ok(C.capChanged("x11-bridge doctor answered") === true && sig === 1, "re-signal: the doctor's mask answer re-signals once");
    ok(C.capChanged("x11-bridge doctor answered") === false && sig === 1, "re-signal: an unchanged answer does not");
    ok(r.perApp().status === "supported", "re-signal: the re-fetch reads supported");
    r.ctx.__cdbCuAskBeforeControl = () => false;
    ok(C.capChanged("ask-before-control switch") === true && sig === 2, "re-signal: the switch turned off re-signals");
    ok((r.ctx.diag || []).filter((l) => l.startsWith("[claude-cu] per-app access check (")).length === 4, "re-signal: each check logs one line on entry");
  }
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

    console.log("\n[3b] per-app truth: 16a prompt suffix, 16b computerUsePerAppAccess, 16c re-signal, 16d pseudo-grant");
    await perAppTruth(patched, blob);
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
