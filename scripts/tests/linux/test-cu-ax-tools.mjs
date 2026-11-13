#!/usr/bin/env node
// Computer Use on Linux: accessibility tools (issue #306).
//
// WHY THIS EXISTS
// ---------------
// Settings -> Extra -> Cowork (Linux) -> "Computer Use: read app controls
// (accessibility)" adds app_list_windows / app_ax_find / app_click / app_type,
// served by the bridges' ax-* subcommands (js/cu_ax_tools.js). Sub-patches
// 15a-15d of fix_computer_use_linux.nim wire the runtime into UPSTREAM's code:
// the tool builder, the tools/list cache key, the teach-mode read-only set and
// upstream's dispatch (kwin mode). A harness that only called our runtime would
// miss every one of those sites, so this one patches a staged copy of the real
// extract and drives upstream's own functions:
//   [1] the compiled patch applies with its full counter, 15a-15d report [OK],
//       the changed chunks pass node --check, the runtime is in the stub.
//   [2] upstream's tool builder (exports.s of the builder chunk, loaded in a
//       vm): switch off -> byte-identical to the pristine builder; on -> the
//       four tools, no coordinate arguments; remote-devices caller and darwin
//       unchanged.
//   [3] upstream's tools/list cache key function and list builder (spliced from
//       the patched chunk, calling the real builder): off -> upstream's key; a
//       flip changes the key and drops the cached list.
//   [4] upstream's teach-mode action classifier: app_ax_find / app_list_windows
//       are read-only on Linux only.
//   [5] kwin mode: upstream's per-session dispatcher (exports.o -> qa) with a
//       fake bridge that records argv and stdin: dispatch, tier refusals,
//       ungranted app, stale index, unknown index, unavailable passthrough,
//       coordinate mapping (screen / window_only / no screenshot / outside),
//       set-text via stdin, enable once, restore on lock release, task boundary.
//       Switch off -> the same answer as the pristine dispatcher, zero spawns.
//   [6] regular mode: the patched handleToolCall injection (Patch 6) spliced
//       from the patched chunk: dispatch, __cuLastShot mapping through the
//       executor's root-pixel -> DIP map; switch off -> "Unknown tool", zero
//       spawns.
//   [6a] regular mode with "Ask before Computer Use controls an app" on
//       (js/cu_consent.js loaded, the session's grants): positions, hints,
//       the app_click fallback center and the multi-monitor pin are the same
//       as with the switch off - the grants are not upstream's kwin context.
//   [7] start: a state file left by a crash is restored at load (switch off);
//       no state file and switch off -> nothing spawned.
// Sections SKIP when the binary or the extract is missing. CDB_CU_PATCH_BIN
// points at another compiled binary (e.g. master's, to see the harness fail).
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  accessSync,
  chmodSync,
  constants,
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_SRC = join(repo, "patches", "linux", "fix_computer_use_linux.nim");
const PATCH_BIN =
  process.env.CDB_CU_PATCH_BIN || join(repo, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = join(
  process.env.CDB_BUNDLE_DIR || join(repo, "tmp", "app.asar.contents"),
  ".vite",
  "build"
);
const AX_JS = join(repo, "js", "cu_ax_tools.js");
const HANDLER_JS = join(repo, "js", "cu_handler_injection.js");
const CONSENT_JS = join(repo, "js", "cu_consent.js");
const EXPECTED_PATCHES = Number(
  /const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(PATCH_SRC, "utf8"))[1]
);
const nodeRequire = createRequire(import.meta.url);
// A wedged section (the suite once hung in [1]) fails the run instead of
// hanging it; unref'd, it never keeps a finished run alive.
const WATCHDOG_MS = Number(process.env.CDB_AX_HARNESS_WATCHDOG_MS) || 10 * 60 * 1000;
setTimeout(() => {
  console.log(`\nFAIL watchdog: the harness did not finish within ${WATCHDOG_MS} ms`);
  process.exit(1);
}, WATCHDOG_MS).unref();
const PATCH_TIMEOUT_MS = 180000;

let pass = 0;
const failures = [];
const short = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 120 ? s.slice(0, 117) + "..." : s;
};
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${short(actual)}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failures.push(label);
  }
}
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const parts = new Map([["index.js", pieces[0]]]);
  for (let i = 1; i < pieces.length; i += 2) parts.set(pieces[i], pieces[i + 1]);
  return parts;
}
// Inverse of sub-patches 15a-15d (the harness's own reconstruction of the
// bundle as the other sub-patches leave it).
function unpatch15(src) {
  return src
    .replace(/,\.\.\.\(process\.platform==="linux"&&globalThis\.__cdbAxTools\?\.\([\w$]+\)\|\|\[\]\)/g, "")
    .replace(/\$\{process\.platform==="linux"&&\(globalThis\.__cdbAxKey\?\.\(\)\|\|""\)\+\(globalThis\.__cdbCuConsent\?\.key\?\.\(\)\|\|""\)\|\|""\}/g, "")
    .replace(/,__cdbAxSid:process\.platform==="linux"\?[\w$]+\.sessionId:void 0/g, "")
    .replace(/if\(process\.platform==="linux"&&globalThis\.__cdbAxHandles\?\.\([\w$]+\)\)return await globalThis\.__cdbAxCall\([^;]*?\}\);/g, "")
    .replace(/return!\(([\w$]+)\.has\(([\w$]+)\)\|\|process\.platform==="linux"&&\(\2==="app_ax_find"\|\|\2==="app_list_windows"\)\)\}/g, "return!$1.has($2)}");
}
const textOf = (r) => (r && Array.isArray(r.content) ? r.content.map((c) => c.text).join("\n") : "");
const tick = () => new Promise((r) => setTimeout(r, 20));

// --- fake bridge ----------------------------------------------------------------
// Records {argv, stdin} per call (JSONL) and answers from a fixture keyed by
// subcommand (ax-find by --window, ax-action by --ref).
const FAKE_BRIDGE = `#!/usr/bin/env node
const fs=require("fs");
const a=process.argv.slice(2);
let stdin="";
process.stdin.on("data",d=>stdin+=d);
process.stdin.on("end",()=>{
  const LOG=process.env.CDB_FAKE_AX_LOG,FEAT=process.env.CDB_FAKE_AX_FEATURES;
  const arg=n=>{const i=a.indexOf(n);return i>=0?a[i+1]:undefined};
  // ax-features: logged on its own file (the main log keeps today's argv
  // sequences). Unset CDB_FAKE_AX_FEATURES = a legacy bridge (clap usage
  // error, exit 2); "__exit1" = runtime failure; anything else is printed.
  if(a[0]==="ax-features"){
    fs.appendFileSync(LOG+".features",JSON.stringify({argv:a,stdin})+"\\n");
    if(FEAT===undefined){process.stderr.write("error: unrecognized subcommand 'ax-features'\\n");process.exit(2)}
    if(FEAT==="__exit1"){process.stderr.write("boom\\n");process.exit(1)}
    process.stdout.write(FEAT);return;
  }
  // Legacy bridge: anything beyond today's flags, actions and stdin shapes is
  // a contract violation of the caller, recorded for the final check.
  if(FEAT===undefined){
    const v2=["--expect-json","--window-ref","--deadline-ms","--root-ref","--skeleton","--max-depth","--max-nodes"];
    const bad=a.some(x=>v2.includes(x))||(a[0]==="ax-action"&&(!["click","set-text"].includes(arg("--action"))||(arg("--action")==="click"&&stdin!=="")));
    if(bad)fs.appendFileSync(LOG+".legacy-violations",JSON.stringify({argv:a,stdin:stdin.length})+"\\n");
  }
  fs.appendFileSync(LOG,JSON.stringify({argv:a,stdin})+"\\n");
  const fx=JSON.parse(fs.readFileSync(process.env.CDB_FAKE_AX_FIX,"utf8"));
  let out=fx[a[0]];
  const once=process.env.CDB_FAKE_AX_ONCE;
  if(once&&a[0]==="ax-find"&&a.includes(once)&&!fs.existsSync(process.env.CDB_FAKE_AX_LOG+".once")){fs.writeFileSync(process.env.CDB_FAKE_AX_LOG+".once","1");process.stdout.write(JSON.stringify({unavailable:"app_not_found",hint:"No accessible application matched the window."}));return}
  // A key may have variants: "<key>|root:<ref>", "<key>|skeleton", "<key>|all", "<key>|role:<role>"
  // (ax-find), "<ref>|<action>" (ax-action); the first that exists wins.
  const pick=(tab,base,vs)=>{if(!tab)return undefined;for(const v of vs){if(v&&tab[base+"|"+v]!==undefined)return[base+"|"+v,tab[base+"|"+v]]}return[base,tab[base]]};
  let key=null;
  if(a[0]==="ax-find"){const app=arg("--app-id")!==undefined;[key,out]=pick(app?fx["ax-find-app"]:fx["ax-find"],app?arg("--app-id")+"|"+(arg("--title")||""):arg("--window"),[arg("--root-ref")&&"root:"+arg("--root-ref"),a.includes("--skeleton")&&"skeleton",a.includes("--all")&&"all",arg("--role")&&"role:"+arg("--role")])}
  if(a[0]==="ax-action")[key,out]=pick(fx["ax-action"],arg("--ref"),[arg("--action")]);
  // {"__seq":[a,b,...]}: successive answers per key (the last one repeats).
  if(out&&Array.isArray(out.__seq)){const f=LOG+".seq."+Buffer.from(a[0]+"\\n"+key).toString("hex");const n=fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0;fs.writeFileSync(f,String(n+1));out=out.__seq[Math.min(n,out.__seq.length-1)]}
  if(out&&out.__exit){process.stderr.write(out.stderr||"");process.exit(out.__exit)}
  if(out===undefined){process.stderr.write("no fixture for "+a.join(" ")+"\\n");process.exit(1)}
  process.stdout.write(JSON.stringify(out));
});
`;
const el = (index, ax_role, role, name, extra = {}) => ({
  index,
  ax_role,
  role,
  name,
  ref: ":1.42/org/a11y/atspi/accessible/" + index,
  states: ["enabled", "sensitive", "showing", "visible"],
  actions: ["click"],
  ...extra,
});
const FIXTURE = {
  windows: [
    { id: "{evil-1}", title: "org.kde.kate", resource_class: "org.evil.spoof", pid: 6666, is_active: true, stacking_order: 9, geometry: { x: 0, y: 0, width: 300, height: 200 } },
    { id: "{evil-2}", title: "Evil", resource_class: "org.evil.kate", pid: 7777, stacking_order: 8, geometry: { x: 0, y: 0, width: 300, height: 200 } },
    { id: "{kate-1}", title: "notes.txt - Kate", resource_class: "org.kde.kate", pid: 1111, is_active: true, is_minimized: false, stacking_order: 3, geometry: { x: 0, y: 0, width: 1200, height: 800 } },
    { id: "{kate-2}", title: "other - Kate", resource_class: "org.kde.kate", pid: 1111, is_active: false, stacking_order: 1, geometry: { x: 50, y: 50, width: 600, height: 400 } },
    { id: "{dolphin-1}", title: "Home - Dolphin", desktop_file_name: "org.kde.dolphin", pid: 2222, is_active: false, stacking_order: 2, geometry: { x: 0, y: 0, width: 900, height: 700 } },
    { id: "{konsole-1}", title: "Konsole", resource_class: "org.kde.konsole", pid: 4242, stacking_order: 4, geometry: { x: 0, y: 0, width: 900, height: 700 } },
    { id: "{code-1}", title: "VS Code", resource_class: "code", stacking_order: 5, geometry: { x: 0, y: 0, width: 900, height: 700 } },
    { id: "{gedit-1}", title: "gedit", desktop_file_name: "org.gnome.gedit", stacking_order: 6, geometry: { x: 0, y: 0, width: 0, height: 0 } },
    { id: "{wl-1}", title: "~ - foot", desktop_file_name: "foot.desktop", stacking_order: 1, geometry: { x: 0, y: 0, width: 800, height: 600 } },
    { id: "{wl-2}", title: "Files", desktop_file_name: "org.gnome.Nautilus", stacking_order: 1, geometry: { x: 0, y: 0, width: 800, height: 600 } },
    { id: "{wl-3}", title: "Pid check", resource_class: "pidapp", pid: 3333, stacking_order: 1, geometry: { x: 0, y: 0, width: 800, height: 600 } },
    { id: "0x0400001", title: "Mousepad", desktop_file_name: "org.xfce.mousepad.desktop", is_active: true, stacking_order: 7, geometry: { x: 0, y: 0, width: 800, height: 600 } },
  ],
  "ax-enable": { previous: false, changed: true, screen_reader: false },
  "ax-restore": { restored: true, is_enabled: false },
  "ax-find": {
    "{kate-1}": {
      app: { name: "kate" },
      window: { id: "{kate-1}", title: "notes.txt - Kate", ref: ":1.42/w", frame_class: "global_frame" },
      coords: "screen",
      scope: "sc-kate",
      matched_by: "pid",
      truncated: false,
      total_seen: 40,
      elements: [
        el(3, "AXButton", "push button", "Save", { rect_screen: { x: 100, y: 200, width: 40, height: 20 } }),
        el(4, "AXButton", "push button", "Far away", { rect_screen: { x: 5000, y: 5000, width: 10, height: 10 } }),
        el(5, "AXTextField", "text", "Search", { states: ["enabled", "editable", "focusable"], rect_screen: { x: 400, y: 100, width: 200, height: 30 } }),
        el(6, "AXTextField", "text", "Title", { states: ["editable", "focused"], value: "draft", ref: "full-field" }),
        el(7, "AXButton", "push button", "Gone", { ref: "stale-ref", rect_screen: { x: 0, y: 0, width: 10, height: 10 } }),
        el(8, "AXStaticText", "label", "Hint", { ref: "no-action-ref", actions: [], rect_screen: { x: 600, y: 600, width: 100, height: 20 } }),
        el(9, "AXButton", "push button", "Moved", { ref: "scope-ref" }),
        el(10, "AXButton", "push button", "Async", { ref: "dispatched-ref" }),
        el(11, "AXSecureTextField", "password text", "Password", { states: ["editable"], value_redacted: true, ref: "pw-ref" }),
      ],
    },
    "{dolphin-1}": {
      app: { name: "dolphin" },
      window: { id: "{dolphin-1}", title: "Home - Dolphin", ref: ":1.50/w", frame_class: "unknown" },
      coords: "window_only",
      matched_by: "app_id",
      truncated: true,
      truncated_reason: "nodes",
      total_seen: 300,
      elements: [el(2, "AXButton", "push button", "Back", { rect_window: { x: 1, y: 1, width: 10, height: 10 } })],
    },
    "{konsole-1}": { app: { name: "konsole" }, window: { id: "{konsole-1}", title: "Konsole", ref: ":1.60/w", frame_class: "unknown" }, coords: "window_only", scope: "sc-konsole", matched_by: "name", truncated: false, total_seen: 2, elements: [el(1, "AXTextArea", "terminal", "Terminal", { states: ["editable"] })] },
    "{evil-1}": { app: { name: "spoof" }, window: { id: "{evil-1}", title: "org.kde.kate", ref: ":1.99/w", frame_class: "unknown" }, coords: "window_only", matched_by: "pid", scope: "sc-evil", truncated: false, total_seen: 1, elements: [el(1, "AXButton", "push button", "Pay", { ref: "evil-ref" })] },
    "{wl-1}": { app: { name: "foot", pid: 5150 }, window: { id: "{wl-1}", title: "~ - foot", ref: ":1.90/w", frame_class: "unknown" }, coords: "window_only", scope: "sc-foot", matched_by: "app_id", truncated: false, total_seen: 2, elements: [el(1, "AXTextArea", "terminal", "foot", { ref: "foot-ref" })] },
    "{wl-2}": { unavailable: "window_changed", hint: "window id now names another toplevel" },
    "{wl-3}": { app: { name: "pidapp", pid: 4444 }, window: { id: "{wl-3}", title: "Pid check", ref: ":1.91/w", frame_class: "unknown" }, coords: "window_only", scope: "sc-pid", matched_by: "pid", truncated: false, total_seen: 1, elements: [el(1, "AXButton", "push button", "X", { ref: "pid-ref" })] },
    "{code-1}": { unavailable: "no_tree_exposed", hint: "Chromium/Electron apps expose a tree only when started with --force-renderer-accessibility" },
    "0x0400001": {
      app: { name: "mousepad" },
      window: { id: "0x0400001", title: "Mousepad", ref: ":1.70/w", frame_class: "x11_global" },
      coords: "screen",
      truncated: false,
      total_seen: 10,
      elements: [el(2, "AXButton", "push button", "Open", { ref: ":1.70/org/a11y/atspi/accessible/2", rect_screen: { x: 1900, y: 1180, width: 40, height: 40 } })],
    },
  },
  "ax-find-app": {
    "org.gnome.TextEditor|": { unavailable: "ambiguous_window", hint: "Several windows match.", candidates: ["notes.txt", "todo.md"] },
    "org.gnome.TextEditor|notes.txt": { app: { name: "gnome-text-editor" }, window: { title: "notes.txt", ref: ":1.80/w", frame_class: "unknown" }, coords: "window_only", scope: "sc-te", matched_by: "app_id", truncated: false, total_seen: 5, elements: [el(4, "AXButton", "push button", "Open", { ref: "te-open" }), el(5, "AXTextField", "text", "Body", { ref: "te-field", states: ["editable"] })] },
    "org.gnome.Calculator|": { app: { name: "gnome-calculator" }, window: { title: "Calculator", ref: ":1.81/w", frame_class: "unknown" }, coords: "window_only", scope: "sc-calc", matched_by: "app_id", truncated: false, total_seen: 3, elements: [el(2, "AXButton", "push button", "Equals", { ref: "calc-eq" })] },
  },
  "ax-action": {
    "te-open": { ok: true, action: "click", method: "action:click" },
    "te-field": { __exit: 2, stderr: "error: set-text: the text on stdin is not valid UTF-8\n" },
    "calc-eq": { ok: true, action: "click", method: "action:click" },
    ":1.42/org/a11y/atspi/accessible/3": { ok: true, action: "click", method: "action:click", post: { focused: false } },
    ":1.42/org/a11y/atspi/accessible/5": { ok: true, action: "set_text", method: "set_text_contents" },
    "full-field": { ok: true, action: "set_text", method: "set_text_contents" },
    "stale-ref": { unavailable: "stale_element", hint: "The element is gone." },
    "no-action-ref": { unavailable: "no_action", hint: "The element exposes no click-like action." },
    "scope-ref": { unavailable: "out_of_scope", hint: "The ref is not in this scope." },
    "dispatched-ref": { ok: null, action: "click", method: "dispatched" },
    "pw-ref": { ok: true, action: "set_text", method: "set_text_contents" },
    ":1.70/org/a11y/atspi/accessible/2": { ok: true, action: "click", method: "action:click" },
  },
};

// --- vm rigs ----------------------------------------------------------------------
// The builder chunk's only chunk dependency is the core chunk; a stub stands in
// for it (grant normalization helpers, constants), node builtins are real. The
// core chunk's export names change every release, so bindCoreNames() reads
// them from the builder chunk's own call sites before any chunk is loaded.
const CORE = {};
const CORE_SITES = {
  // let o=e.jI(n),s=t=>{let n=e.EI(t.bundleId,t.displayName);
  deniedFactory: [/let [\w$]+=([\w$]+)\.([\w$]+)\([\w$]+\),[\w$]+=[\w$]+=>\{let [\w$]+=\1\.[\w$]+\([\w$]+\.bundleId,[\w$]+\.displayName\)/, 2, () => () => false],
  tierFor: [/let [\w$]+=([\w$]+)\.[\w$]+\([\w$]+\),[\w$]+=[\w$]+=>\{let [\w$]+=\1\.([\w$]+)\([\w$]+\.bundleId,[\w$]+\.displayName\)/, 2, () => "full"],
  // ||e.AI(t.bundleId,t.displayName)))
  policyDenied: [/\|\|([\w$]+)\.([\w$]+)\([\w$]+\.bundleId,[\w$]+\.displayName\)\)\)/, 2, () => false],
  // {...e.MI,...r.getGrantFlags()}
  defaultFlags: [/\{\.\.\.([\w$]+)\.([\w$]+),\.\.\.[\w$]+\.getGrantFlags\(\)\}/, 2, {}],
  // deniedBundleIds:[...e.CI,
  deniedIds: [/deniedBundleIds:\[\.\.\.([\w$]+)\.([\w$]+),/, 2, []],
  // scale:{type:"number",description:e.TI}
  scaleDesc: [/scale:\{type:"number",description:([\w$]+)\.([\w$]+)\}/, 2, "Scale factor."],
};
function bindCoreNames(src) {
  const missing = [];
  for (const [what, [re, g, value]] of Object.entries(CORE_SITES)) {
    const m = re.exec(src);
    if (m) CORE[m[g]] = value;
    else missing.push(what);
  }
  return missing;
}
const coreStub = new Proxy(
  {},
  {
    get(_, k) {
      if (typeof k === "string" && Object.hasOwn(CORE, k)) return CORE[k];
      if (k === "__esModule") return true;
      if (typeof k === "symbol") return undefined;
      return () => undefined;
    },
  }
);
// The runtime registers process.once("exit"): every context gets a process
// view that records it instead of arming the harness's own exit.
function procView(exitHandlers) {
  return new Proxy(process, {
    get(t, k) {
      if (k === "once" || k === "on")
        return (ev, fn) => {
          if (ev === "exit") exitHandlers.push(fn);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
function makeCtx(opts = {}) {
  const ctx = {
    process: opts.process || procView(opts.exitHandlers || []),
    console,
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    AbortController,
    URL,
    Buffer,
    Promise,
  };
  ctx.require = (id) =>
    id === "electron"
      ? {
          app: { getPath: () => opts.userData },
          // kwin pre-screenshot frame: one 1280x720 DIP display at scale 2.
          screen: { getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 2 }) },
        }
      : nodeRequire(id);
  ctx.__cdbDiag = (...a) => (opts.diag || []).push(a.join(" "));
  vm.createContext(ctx);
  return ctx;
}
function loadChunk(ctx, src) {
  const mod = { exports: {} };
  vm.runInContext("(function(exports,require,module){" + src + "\n})", ctx)(
    mod.exports,
    // 4.23118.0: the tool-builder chunk requires electron at load (ctx stub).
    (id) => (id.startsWith("./") ? coreStub : id === "electron" ? ctx.require(id) : nodeRequire(id)),
    mod
  );
  return mod.exports;
}
// The export key under which the chunk exposes function `fn` (minified keys
// move between releases).
function exportKeyFor(src, fn) {
  const esc = fn.replace(/\$/g, "\\$");
  const m = new RegExp(`Object\\.defineProperty\\(exports,(["\`])([\\w$]+)\\1,\\{enumerable:!0,get:function\\(\\)\\{return ${esc}\\}\\}\\)`).exec(src);
  return m ? m[2] : null;
}
function loadAx(ctx) {
  vm.runInContext(readFileSync(AX_JS, "utf8"), ctx);
}

let skipped = false;
let patchMissing = false;
try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  patchMissing = true;
}
const stubPath = join(BUILD_DIR, "index.js");
if (patchMissing || !existsSync(stubPath)) {
  skipped = true;
  console.log(
    "\n  SKIP real-bundle sections: " +
      (patchMissing
        ? `${PATCH_BIN} is not compiled (run: make -C patches linux/fix_computer_use_linux)`
        : "no extract under tmp/app.asar.contents/ (set CDB_BUNDLE_DIR to point at one)")
  );
} else {
  const scratch = mkdtempSync(join(tmpdir(), "cdb-cu-ax-"));
  const savedEnv = { ...process.env };
  try {
    const chunks = readdirSync(BUILD_DIR)
      .filter((d) => /^index.*\.chunk-.*\.js$/.test(d))
      .sort();
    let blob = readFileSync(stubPath, "utf8");
    for (const c of chunks) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(join(BUILD_DIR, c), "utf8");
    const staged = join(scratch, "staged_index.js");
    writeFileSync(staged, blob);
    const pristine = splitParts(blob);

    // ---------------------------------------------------------------- [1]
    console.log("\n[1] the compiled patch applies, 15a-15d report [OK]");
    const r1 = spawnSync(PATCH_BIN, [staged], { encoding: "utf8", timeout: PATCH_TIMEOUT_MS, killSignal: "SIGKILL" });
    const out1 = String(r1.stdout || "") + String(r1.stderr || "");
    check("patch exits 0", r1.status, 0);
    check(
      `[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} reported`,
      out1.includes(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} sub-patches applied`),
      true
    );
    for (const id of ["15a", "15b", "15c", "15d"])
      check(`${id} reported [OK]`, new RegExp(`\\[OK\\] ${id} `).test(out1), true);
    if (r1.status !== 0) console.log(out1.split("\n").filter((l) => /FAIL|Error/.test(l)).join("\n"));
    const patchedBlob = readFileSync(staged, "utf8");
    const patched = splitParts(patchedBlob);
    const r2 = spawnSync(PATCH_BIN, [staged], { encoding: "utf8", timeout: PATCH_TIMEOUT_MS, killSignal: "SIGKILL" });
    check(
      "second run: idempotent, file unchanged",
      r2.status === 0 && readFileSync(staged, "utf8") === patchedBlob,
      true
    );
    const findPart = (re) => [...patched.keys()].find((k) => re.test(patched.get(k)));
    const builderChunk = [...pristine.keys()].find((k) => /\.\.\.[\w$]+\.appScoped\?[\w$]+\([\w$]+\.appScoped\.supportsRawInput/.test(pristine.get(k)));
    const keyChunk = findPart(/__cdbAxKey\?\.\(\)/) || [...pristine.keys()].find((k) => /\.adaptiveResolution\}`;/.test(pristine.get(k)));
    const roChunk = [...pristine.keys()].find((k) => /===(["`])computer_batch\1\)\{let [\w$]+=[\w$]+\.input\?\.actions;/.test(pristine.get(k)));
    const handlerChunk = [...pristine.keys()].find((k) => /handleToolCall:async\([\w$]+,[\w$]+,[\w$]+,[\w$]+\)=>\{let [\w$]+=[\w$]+\([\w$]+\);if\([\w$]+\([\w$]+\.sessionId,[\w$]+\.sessionType\)/.test(pristine.get(k)));
    const bsrc = builderChunk ? pristine.get(builderChunk) : "";
    const coreMissing = bindCoreNames(bsrc);
    check("core-chunk helpers located in the builder chunk", coreMissing.join(","), "");
    const builderFn = (/function ([\w$]+)\(([\w$]+),[\w$]+,[\w$]+\)\{let [\w$]+=\2\.hitTest===/.exec(bsrc) || [])[1];
    const bindFn = (/function ([\w$]+)\([\w$]+,[\w$]+,[\w$]+\)\{let\{logger:[\w$]+,serverName:[\w$]+\}=[\w$]+,[\w$]+,[\w$]+=[\w$]+\.skipFirstRequestWarnings/.exec(bsrc) || [])[1];
    const BKEY = builderFn && exportKeyFor(bsrc, builderFn);
    const DKEY = bindFn && exportKeyFor(bsrc, bindFn);
    check("builder + per-session dispatcher exported by the chunk", !!BKEY && !!DKEY, true);
    console.log(`  (builder ${builderChunk} ${builderFn} as exports.${BKEY}, dispatcher ${bindFn} as exports.${DKEY}, cache key ${keyChunk}, read-only set ${roChunk}, handler ${handlerChunk})`);
    for (const name of ["index.js", builderChunk, keyChunk, roChunk]) {
      if (!name) continue;
      const f = join(scratch, "check-" + name);
      writeFileSync(f, patched.get(name));
      let ok = true;
      try {
        execFileSync("node", ["--check", f], { stdio: "pipe", timeout: 60000, killSignal: "SIGKILL" });
      } catch {
        ok = false;
      }
      check(`node --check ${name}`, ok, true);
    }
    const axSrc = readFileSync(AX_JS, "utf8").trim();
    check(
      "runtime js/cu_ax_tools.js injected verbatim, once",
      [...patched.values()].reduce((n, b) => n + b.split(axSrc).length - 1, 0),
      1
    );
    // "Today": the patched bundle without sub-patches 15a-15d, i.e. what the
    // other sub-patches produce. Switch off must behave exactly like it.
    const today = new Map([...patched].map(([k, v]) => [k, unpatch15(v)]));
    check(
      "today = patched minus 15a-15d (no hook left)",
      [...today.values()].some((b) => /__cdbAx(Tools|Key|Handles|Sid)\?\.|__cdbAxSid:|"app_list_windows"\)\)\}/.test(b)),
      false
    );

    // ---------------------------------------------------------------- [2]
    console.log("\n[2] upstream's tool builder");
    const userData = join(scratch, "userData");
    mkdirSync(userData);
    const LINUX_CAPS = { screenshotFiltering: "none", platform: "linux" };
    const pristineBuilder = loadChunk(makeCtx({ userData }), today.get(builderChunk))[BKEY];
    const bctx = makeCtx({ userData });
    const patchedBuilder = loadChunk(bctx, patched.get(builderChunk))[BKEY];
    loadAx(bctx);
    const base = JSON.stringify(pristineBuilder(LINUX_CAPS, "pixels"));
    check("switch absent: builder output identical to today", JSON.stringify(patchedBuilder(LINUX_CAPS, "pixels")), base);
    bctx.__cdbCuAxElements = () => false;
    check("switch false: identical", JSON.stringify(patchedBuilder(LINUX_CAPS, "pixels")), base);
    bctx.__cdbCuAxElements = () => "yes";
    check("switch non-boolean: identical", JSON.stringify(patchedBuilder(LINUX_CAPS, "pixels")), base);
    bctx.__cdbCuAxElements = () => true;
    const on = patchedBuilder(LINUX_CAPS, "pixels");
    const baseNames = JSON.parse(base).map((t) => t.name);
    check("switch on: the four tools appended", JSON.stringify(on.map((t) => t.name)), JSON.stringify([...baseNames, "app_list_windows", "app_ax_find", "app_click", "app_type"]));
    check(
      "switch on: upstream's tools unchanged",
      JSON.stringify(on.slice(0, baseNames.length)),
      base
    );
    const axTools = on.slice(baseNames.length);
    const props = (i) => Object.keys(axTools[i]?.inputSchema?.properties || {}).join(",");
    check(
      "no coordinate arguments on our tools",
      axTools.some((t, i) => /coordinate|region|path/.test(props(i))),
      false
    );
    check("app_ax_find args", props(1), "app,window_id,role,title_contains");
    check("app_click args", props(2), "app,window_id,element_index,target");
    check("app_type args", props(3) + "|" + (axTools[3]?.inputSchema?.required || []).join(","), "app,window_id,element_index,target,text,overwrite_existing|app,text");
    const descBytes = axTools.reduce((n, t) => n + t.description.length + Object.values(t.inputSchema.properties).reduce((m, p) => m + (p.description || "").length, 0), 0);
    check("descriptions within ~2.5 KB", axTools.length === 4 && descBytes <= 2600, true);
    check(
      "remote-devices caller (saveToDisk:false): identical to today",
      JSON.stringify(patchedBuilder({ ...LINUX_CAPS, teachMode: false, saveToDisk: false }, "pixels")),
      JSON.stringify(pristineBuilder({ ...LINUX_CAPS, teachMode: false, saveToDisk: false }, "pixels"))
    );
    // Off Linux: our spread is never evaluated (process.platform gate).
    const dctx = makeCtx({ userData, process: { platform: "darwin", env: {} } });
    const darwinBuilder = loadChunk(dctx, patched.get(builderChunk))[BKEY];
    dctx.__cdbAxTools = () => {
      throw new Error("called off Linux");
    };
    const DARWIN_CAPS = { screenshotFiltering: "native", platform: "darwin" };
    check(
      "darwin: identical to today, runtime never called",
      JSON.stringify(darwinBuilder(DARWIN_CAPS, "pixels")),
      JSON.stringify(loadChunk(makeCtx({ userData, process: { platform: "darwin", env: {} } }), today.get(builderChunk))[BKEY](DARWIN_CAPS, "pixels"))
    );

    // ---------------------------------------------------------------- [3]
    console.log("\n[3] upstream's tools/list cache key");
    // Cross-chunk export names (`t.wP()`, `t.zP`, ...) change every release:
    // capture them instead of pinning them.
    const VA_RE =
      /function (?<va>[\w$]+)\(\)\{let (?<loc>[\w$]+)=`\$\{(?<fa>[\w$]+)\(\)\}:\$\{(?<ns>[\w$]+)\.(?<teach>[\w$]+)\(\)\}:\$\{\k<ns>\.(?<adapt>[\w$]+)\(\)\.adaptiveResolution\}(?:\$\{process\.platform==="linux"&&\(globalThis\.__cdbAxKey\?\.\(\)\|\|""\)\+\(globalThis\.__cdbCuConsent\?\.key\?\.\(\)\|\|""\)\|\|""\})?`;\k<loc>!==(?<key>[\w$]+)&&\((?<ma>[\w$]+)=void 0,(?<ga>[\w$]+)=!1,\k<key>=\k<loc>\)\}/;
    const PA_RE =
      /function (?<pa>[\w$]+)\((?<arg>[\w$]+)\)\{return (?<ha>[\w$]+)=[\w$]+\(\),(?<bns>[\w$]+)\.(?<bm>[\w$]+)\(\{\.\.\.(?<ns>[\w$]+)\.(?<caps>[\w$]+),teachMode:\k<ns>\.(?<teach>[\w$]+)\(\),adaptiveResolution:\k<ns>\.(?<adapt>[\w$]+)\(\)\.adaptiveResolution,appScoped:\k<ha>\?\{supportsRawInput:!0\}:void 0\},\k<ns>\.(?<mode>[\w$]+)\(\),\k<arg>\)\.map\(\(\k<arg>=>\(\{name:\k<arg>\.name,description:\k<arg>\.description\?\?"",inputSchema:\k<arg>\.inputSchema\}\)\)\)\}/;
    const keyRig = (src, ctx, builder) => {
      const va = VA_RE.exec(src);
      const pa = PA_RE.exec(src);
      if (!va || !pa) return null;
      const g = va.groups;
      const h = pa.groups;
      if (g.ns !== h.ns || g.teach !== h.teach || g.adapt !== h.adapt) return null;
      ctx.__keyBuilder = builder;
      return vm.runInContext(
        `(function(){var ${g.key},${g.ma},${g.ga},${h.ha};function ${g.fa}(){return!1}` +
          `var ${g.ns}={${g.teach}:function(){return!1},${g.adapt}:function(){return{adaptiveResolution:!0}},${h.caps}:${JSON.stringify(LINUX_CAPS)},${h.mode}:function(){return"pixels"}};` +
          `var ${h.bns}={${h.bm}:function(){return __keyBuilder.apply(null,arguments)}};${va[0]}${pa[0]}` +
          `return{va:${g.va},pa:${h.pa},key:function(){return ${g.key}},cached:function(){return ${g.ma}},cache:function(v){${g.ma}=v}}})()`,
        ctx
      );
    };
    const kp = keyRig(today.get(keyChunk), makeCtx({ userData }), pristineBuilder);
    const kctx = makeCtx({ userData });
    const kq = keyRig(patched.get(keyChunk), kctx, null);
    check("cache key + list functions spliced (today)", !!kp, true);
    check("cache key + list functions spliced (patched)", !!kq, true);
    if (kp && kq) {
      // The patched pair runs against the patched builder in its own context.
      const kb = loadChunk(kctx, patched.get(builderChunk))[BKEY];
      kctx.__keyBuilder = kb;
      loadAx(kctx);
      kp.va();
      kq.va();
      check("switch off: key identical to upstream's", kq.key(), kp.key());
      check(
        "switch off: tools/list identical to upstream's",
        JSON.stringify(kq.pa(void 0)),
        JSON.stringify(kp.pa(void 0))
      );
      kq.cache(["cached-list"]);
      kq.va();
      check("same key: cached list kept", JSON.stringify(kq.cached()), JSON.stringify(["cached-list"]));
      kctx.__cdbCuAxElements = () => true;
      kq.va();
      check("switch flipped on: key differs", kq.key() !== kp.key(), true);
      check("switch flipped on: cached list dropped", kq.cached(), undefined);
      check(
        "switch on: tools/list has the four tools",
        kq.pa(void 0).filter((t) => /^app_(list_windows|ax_find|click|type)$/.test(t.name)).length,
        4
      );
    }

    // ---------------------------------------------------------------- [4]
    console.log("\n[4] upstream's teach-mode action classifier");
    const WU_RE =
      /function ([\w$]+)\(([\w$]+)\)\{let\{name:([\w$]+)\}=\2;if\(([\w$]+)\(\3\)\)return!1;if\(!([\w$]+)\(\3\)\)return!0;let ([\w$]+)=([\w$]+)\(\3\);if\(\6===(["`])computer_batch\8\)/;
    const wuRig = (src, plat) => {
      const m = WU_RE.exec(src);
      if (!m) return null;
      const [, wu, , , hu, bu, , zu] = m;
      const piece = (re) => (re.exec(src) || [""])[0];
      const esc = (s) => s.replace(/\$/g, "\\$");
      const zuSrc = piece(new RegExp(`function ${esc(zu)}\\(([\\w$]+)\\)\\{return \\1\\.includes\\([^{}]*\\}`));
      const buSrc = piece(new RegExp(`function ${esc(bu)}\\(([\\w$]+)\\)\\{return \\1\\.startsWith\\([^{}]*\\}`));
      const huM = new RegExp(`function ${esc(hu)}\\(([\\w$]+)\\)\\{return ${esc(bu)}\\(\\1\\)&&([\\w$]+)\\.has\\(${esc(zu)}\\(\\1\\)\\)\\}`).exec(src);
      if (!huM) return null;
      const setSrc = (n) => piece(new RegExp(`(?<![\\w$.])${esc(n)}=new Set\\(\\[[^\\]]*\\]\\)`));
      const start = m.index;
      const endM = /return!(?:\([\w$]+\.has\([\w$]+\)\|\|process\.platform==="linux"&&\([^)]*\)\)|[\w$]+\.has\([\w$]+\))\}/g;
      endM.lastIndex = start;
      const e = endM.exec(src);
      const usedSet = /return!\(?([\w$]+)\.has/.exec(e[0])[1];
      const ctx = makeCtx({ process: { platform: plat } });
      return vm.runInContext(
        `(function(){var ${setSrc(huM[2])},${setSrc(usedSet)};${zuSrc}${buSrc}${huM[0]}${src.slice(start, e.index + e[0].length)}return ${wu}})()`,
        ctx
      );
    };
    const roSrcP = pristine.get(roChunk);
    const roSrcQ = patched.get(roChunk);
    const wuP = wuRig(roSrcP, "linux");
    const wuQ = wuRig(roSrcQ, "linux");
    const wuD = wuRig(roSrcQ, "darwin");
    check("classifier spliced (pristine, patched)", !!wuP && !!wuQ && !!wuD, true);
    if (wuP && wuQ && wuD) {
      const isAction = (f, n) => f({ name: "mcp__computer-use__" + n });
      check("pristine: app_ax_find counts as an action", isAction(wuP, "app_ax_find"), true);
      check("linux: app_ax_find read-only", isAction(wuQ, "app_ax_find"), false);
      check("linux: app_list_windows read-only", isAction(wuQ, "app_list_windows"), false);
      check("linux: app_click still an action", isAction(wuQ, "app_click"), true);
      check("linux: app_type still an action", isAction(wuQ, "app_type"), true);
      check("linux: screenshot still read-only", isAction(wuQ, "screenshot"), false);
      check("darwin: app_ax_find unchanged (action)", isAction(wuD, "app_ax_find"), true);
    }

    // ---------------------------------------------------------------- [5]
    console.log("\n[5] kwin mode through upstream's dispatcher");
    const bin = join(scratch, "fake-bridge");
    writeFileSync(bin, FAKE_BRIDGE);
    chmodSync(bin, 0o755);
    const logFile = join(scratch, "bridge.log");
    const fixFile = join(scratch, "fixture.json");
    writeFileSync(fixFile, JSON.stringify(FIXTURE));
    process.env.CDB_FAKE_AX_LOG = logFile;
    process.env.CDB_FAKE_AX_FIX = fixFile;
    delete process.env.KWIN_PORTAL_BRIDGE_BIN;
    const calls = () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
    const resetLog = () => writeFileSync(logFile, "");
    const statePath = join(userData, "cdb-ax-state.json");
    const lockCalls = [];
    const kwinExecutor = () => ({
      capabilities: { screenshotFiltering: "none", platform: "linux", hostBundleId: "com.anthropic.claude" },
      async __setLockHeld(h) {
        lockCalls.push(["lock", h]);
      },
      async __cuTaskBoundary(id, src, holder) {
        lockCalls.push(["boundary", id, src, holder]);
      },
    });
    const GRANTS = [
      { bundleId: "org.kde.kate", displayName: "Kate", tier: "full" },
      { bundleId: "org.kde.dolphin", displayName: "Dolphin", tier: "read" },
      { bundleId: "org.kde.konsole", displayName: "Konsole", tier: "click" },
      { bundleId: "code", displayName: "Code", tier: "full" },
    ];
    let dims = { width: 1280, height: 720, displayWidth: 2560, displayHeight: 1440, originX: 0, originY: 0, scaleFactor: 1 };
    const serverCtx = (executor) => ({
      logger: { debug() {}, silly() {}, info() {}, warn() {}, error() {} },
      serverName: "computer-use",
      executor,
      isDisabled: () => false,
      ensureOsPermissions: async () => ({ granted: true }),
      getSubGates: () => ({}),
    });
    const sessionCtx = (sessionId) => ({
      sessionId,
      getAllowedApps: () => GRANTS,
      getGrantFlags: () => ({}),
      getUserDeniedBundleIds: () => [],
      getSelectedDisplayId: () => undefined,
      getLastScreenshotDims: () => dims,
    });
    const diag = [];
    const exitHandlers = [];
    const kctx2 = makeCtx({ userData, diag, exitHandlers });
    kctx2.__cuKwinMode = true;
    kctx2.__cuKwinBridgeBin = bin;
    kctx2.__linuxExecutor = kwinExecutor();
    const kexp = loadChunk(kctx2, patched.get(builderChunk));
    const pexp = loadChunk(makeCtx({ userData }), today.get(builderChunk));
    loadAx(kctx2);
    const pristineDispatch = pexp[DKEY](serverCtx(kwinExecutor()), "pixels", sessionCtx("sess-A"));
    const dispatch = kexp[DKEY](serverCtx(kctx2.__linuxExecutor), "pixels", sessionCtx("sess-A"));
    resetLog();

    // a. switch off: upstream's own answer, nothing spawned.
    for (const [tool, args] of [
      ["app_ax_find", { app: "org.kde.kate" }],
      ["app_click", { app: "org.kde.kate", element_index: 3 }],
      ["app_list_windows", { app: "org.kde.kate" }],
      ["app_focus", { app: "org.kde.kate", element_index: 3 }],
      ["app_scroll", { app: "org.kde.kate", element_index: 3 }],
    ]) {
      const a = textOf(await pristineDispatch(tool, args));
      const b = textOf(await dispatch(tool, args));
      check(`switch off: ${tool} answers like today`, b, a);
    }
    check("switch off: zero bridge spawns", calls().length, 0);
    check("switch off: no state file", existsSync(statePath), false);

    kctx2.__cdbCuAxElements = () => true;
    // b. list windows.
    let r = await dispatch("app_list_windows", { app: "org.kde.kate" });
    let wl = [];
    try {
      wl = JSON.parse(textOf(r) || "[]");
    } catch {}
    check("app_list_windows: the app's two windows", wl.map((w) => w.window_id).join(","), "{kate-1},{kate-2}");
    check("app_list_windows: spoof window not listed", wl.some((w) => w.window_id === "{evil-1}"), false);
    check("app_list_windows: main = active window", wl.filter((w) => w.is_main).map((w) => w.window_id).join(), "{kate-1}");
    check("app_list_windows: no accessibility switch touched", calls().some((c) => c.argv[0] === "ax-enable"), false);
    // c. find, screen coords mapped into upstream's screenshot frame.
    resetLog();
    r = await dispatch("app_ax_find", { app: "org.kde.kate" });
    let t = textOf(r);
    check("find: not an error", !!r.isError, false);
    check("find: [3] line with AX role, AT-SPI role, name, mapped center", t.includes('[3] AXButton (push button) "Save" at (60, 105)'), true);
    check("find: noise states dropped, editable kept", t.includes('[5] AXTextField (text) "Search" (editable, focusable) at (250, 58)'), true);
    check("find: element off the screenshot", t.includes('[4] AXButton (push button) "Far away" outside the last screenshot'), true);
    check("find: value shown", t.includes('value "draft"'), true);
    const argv = calls().map((c) => c.argv.join(" "));
    check("find: enable, windows, ax-find in order", JSON.stringify(argv.filter((a) => /^(ax-enable|ax-find|windows)/.test(a)).map((a) => a.split(" ")[0]).sort()), JSON.stringify(["ax-enable", "ax-find", "windows"]));
    check("find: ax-find --window <active window>", argv.includes("ax-find --window {kate-1}"), true);
    const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    check("enable: marker persisted", st && st.previous === false && st.changed === true, true);
    check("enable: --holder-pid <main pid>", argv.includes("ax-enable --holder-pid " + process.pid), true);
    // d. role / title filters pass through.
    resetLog();
    await dispatch("app_ax_find", { app: "org.kde.kate", window_id: "{kate-1}", role: "AXButton", title_contains: "Sa" });
    check("find: filters as argv", calls().map((c) => c.argv.join(" ")).includes("ax-find --window {kate-1} --role AXButton --title-contains Sa"), true);
    check("enable ran once (memo)", calls().some((c) => c.argv[0] === "ax-enable"), false);
    // e. click by index.
    resetLog();
    r = await dispatch("app_click", { app: "org.kde.kate", element_index: 3 });
    check("click: pressed", textOf(r).startsWith("Pressed [3] AXButton (push button)"), true);
    check("click: ax-action argv", calls().map((c) => c.argv.join(" ")).includes("ax-action --scope sc-kate --ref :1.42/org/a11y/atspi/accessible/3 --action click"), true);
    // f. unknown index, coordinates refused.
    r = await dispatch("app_click", { app: "org.kde.kate", element_index: 99 });
    check("unknown index: call app_ax_find again", r.isError === true && textOf(r).includes("No element [99]") && textOf(r).includes("Call app_ax_find again"), true);
    r = await dispatch("app_click", { app: "org.kde.kate", coordinate: [10, 10] });
    check("coordinates refused", r.isError === true && textOf(r).includes("takes no coordinates"), true);
    // g. stale element: message, then the index is gone.
    r = await dispatch("app_click", { app: "org.kde.kate", element_index: 7 });
    check("stale: tells the model to find again", r.isError === true && textOf(r).includes("is gone") && textOf(r).includes("app_ax_find again"), true);
    r = await dispatch("app_click", { app: "org.kde.kate", element_index: 3 });
    check("stale: window's indexes dropped", textOf(r).includes("No element [3]"), true);
    // The window's numbers by name, from a listing (a re-listed window
    // numbers above every number it showed before).
    const kn = {};
    const numsOf = (txt) => {
      for (const m of txt.matchAll(/^\[(\d+)\] \w+ \([^)]*\) "([^"]*)"/gm)) kn[m[2]] = Number(m[1]);
    };
    numsOf(textOf(await dispatch("app_ax_find", { app: "org.kde.kate" })));
    check("legacy stale: the re-listed window numbers above the dropped numbers", kn.Save > 11 && kn.Password > 11, true);
    // h. no action -> left_click hint with the mapped position.
    r = await dispatch("app_click", { app: "org.kde.kate", element_index: kn.Hint });
    check("no_action: left_click fallback position", r.isError === true && textOf(r).includes("no_action") && textOf(r).includes("at (325, 305)"), true);
    r = await dispatch("app_click", { app: "org.kde.kate", element_index: kn.Moved });
    check("out_of_scope: like stale, find again", r.isError === true && textOf(r).includes("is gone") && textOf(r).includes("app_ax_find again"), true);
    numsOf(textOf(await dispatch("app_ax_find", { app: "org.kde.kate" })));
    resetLog();
    r = await dispatch("app_click", { app: "org.kde.kate", element_index: kn.Async });
    check("dispatched (ok:null): result unknown, not an error", !r.isError && textOf(r).includes("result unknown"), true);
    check("dispatched: sent exactly once (no retry)", calls().filter((c) => c.argv[0] === "ax-action").length, 1);
    r = await dispatch("app_type", { app: "org.kde.kate", element_index: kn.Password, text: "pw" });
    check("password field: redacted value needs overwrite_existing", r.isError === true && textOf(r).includes("overwrite_existing"), true);
    r = await dispatch("app_type", { app: "org.kde.kate", element_index: kn.Password, text: "pw", overwrite_existing: true });
    check("password field: typed with overwrite_existing", !r.isError, true);
    // i. set-text: text via stdin, never argv.
    resetLog();
    r = await dispatch("app_type", { app: "org.kde.kate", element_index: kn.Search, text: "hunter2 secret" });
    check("type: done", textOf(r).startsWith(`Set the text of [${kn.Search}]`), true);
    const st1 = calls().find((c) => c.argv[0] === "ax-action");
    check("type: argv has no text", !!st1 && st1.argv.join(" ") === "ax-action --scope sc-kate --ref :1.42/org/a11y/atspi/accessible/5 --action set-text", true);
    check("type: text on stdin", st1 && st1.stdin, "hunter2 secret");
    r = await dispatch("app_type", { app: "org.kde.kate", element_index: kn.Title, text: "x" });
    check("type: existing text refused without overwrite_existing", r.isError === true && textOf(r).includes("overwrite_existing"), true);
    r = await dispatch("app_type", { app: "org.kde.kate", element_index: kn.Title, text: "x", overwrite_existing: true });
    check("type: overwrite_existing allows it", !r.isError, true);
    r = await dispatch("app_type", { app: "org.kde.kate", element_index: kn.Save, text: "x" });
    check("type: non-text control refused", r.isError === true && textOf(r).includes("Only target TEXT fields"), true);
    resetLog();
    r = await dispatch("app_type", { app: "org.kde.kate", target: "focused", text: "y", overwrite_existing: true });
    check("type focused: full walk then the focused element", calls().map((c) => c.argv.join(" ")).join("|"), "windows|ax-find --window {kate-1} --all|ax-action --scope sc-kate --ref full-field --action set-text");
    // j. tiers (upstream's check): dolphin read, konsole click.
    resetLog();
    r = await dispatch("app_click", { app: "org.kde.dolphin", element_index: 2 });
    check("tier read: click refused by upstream's check", r.isError === true && textOf(r).includes('requires tier "click"'), true);
    r = await dispatch("app_type", { app: "org.kde.konsole", element_index: 1, text: "ls" });
    check("tier click: type refused", r.isError === true && textOf(r).includes('requires tier "full"'), true);
    check("tier refusals: nothing spawned", calls().length, 0);
    r = await dispatch("app_ax_find", { app: "org.kde.dolphin" });
    t = textOf(r);
    check("tier read: find allowed", !r.isError, true);
    check("window_only: position unknown", t.includes('[2] AXButton (push button) "Back" position unknown - take a screenshot to click it'), true);
    check("window_only: header says so; truncated reason", t.includes("does not report element positions") && t.includes("walk truncated (nodes)"), true);
    r = await dispatch("app_ax_find", { app: "org.kde.konsole" });
    check("kwin: pid known but matched by name -> refused", r.isError === true && textOf(r).startsWith("unavailable: app_not_confirmed"), true);
    resetLog();
    r = await dispatch("app_ax_find", { app: "org.kde.kate", window_id: "{evil-1}" });
    check("window titled like a granted app (other WM_CLASS) refused via window_id", r.isError === true && textOf(r).includes("is not a window of org.kde.kate"), true);
    check("spoof window: never searched", calls().some((c) => c.argv.includes("{evil-1}")), false);
    const heldDispatch = kexp[DKEY](serverCtx(kctx2.__linuxExecutor), "pixels", {
      ...sessionCtx("sess-C"),
      checkCuLock: async () => ({ holder: "other-session", isSelf: false }),
      checkExclusiveLock: async () => ({ holder: "other-session", isSelf: false }),
    });
    resetLog();
    r = await heldDispatch("app_ax_find", { app: "org.kde.kate" });
    check("another session holds the lock: upstream's cu_lock_held refusal", r.isError === true && (r.telemetry?.error_kind === "cu_lock_held" || textOf(r).includes("Another Claude session")), true);
    check("lock held: nothing spawned", calls().length, 0);
    r = await dispatch("app_ax_find", { app: "org.gnome.Other" });
    check("ungranted app: upstream's refusal", r.isError === true && textOf(r).includes("not in the granted-applications list"), true);
    // k. unavailable passthrough.
    r = await dispatch("app_ax_find", { app: "code" });
    check("unavailable: reason + hint passed through", r.isError === true && textOf(r).startsWith("unavailable: no_tree_exposed - Chromium/Electron"), true);
    // l. wrong window id.
    r = await dispatch("app_ax_find", { app: "org.kde.kate", window_id: "{dolphin-1}" });
    check("window of another app refused", r.isError === true && textOf(r).includes("is not a window of org.kde.kate"), true);
    // m. no screenshot yet.
    dims = undefined;
    r = await dispatch("app_ax_find", { app: "org.kde.kate" });
    // Upstream maps a pre-screenshot coordinate as x/scaleFactor + origin, so
    // (240, 420) at scale 2 is the element's center (120, 210).
    check("no screenshot (kwin): positions in upstream's pre-screenshot frame", textOf(r).includes('"Save" at (240, 420)') && textOf(r).includes("No screenshot yet"), true);
    // Grants by display name / lowercase / last segment resolve to the grant.
    for (const a of ["Kate", "kate", "KATE"]) {
      r = await dispatch("app_ax_find", { app: a });
      check(`grant resolved from app "${a}"`, !r.isError && textOf(r).includes('window "notes.txt - Kate"'), true);
    }
    r = await dispatch("app_click", { app: "Dolphin", element_index: 2 });
    check("display name resolves to the grant's tier (read -> click refused)", r.isError === true && textOf(r).includes('requires tier "click"'), true);
    r = await dispatch("app_ax_find", { app: "org.kde.kate", window_id: "{evil-2}" });
    check("org.evil.kate window refused for an org.kde.kate grant", r.isError === true && textOf(r).includes("is not a window of org.kde.kate"), true);
    r = await dispatch("app_ax_find", { app: "Kate", window_id: "{evil-1}" });
    check("spoof title still refused with a display-name app", r.isError === true && textOf(r).includes("is not a window of Kate"), true);
    // Two monitors in kwin mode: upstream's own display pin (switch_display's
    // onDisplayPinned) moves to the window's display.
    {
      const pins = [];
      const KD = [
        { displayId: 1, label: "eDP-1", originX: 0, originY: 0, width: 2560, height: 1440, scaleFactor: 1 },
        { displayId: 2, label: "HDMI-A-1", originX: 2560, originY: 0, width: 1920, height: 1080, scaleFactor: 1 },
      ];
      kctx2.__linuxExecutor.listDisplays = async () => KD;
      dims = { width: 1280, height: 720, displayWidth: 1920, displayHeight: 1080, originX: 2560, originY: 0, displayId: 2 };
      const d2 = kexp[DKEY](serverCtx(kctx2.__linuxExecutor), "pixels", { ...sessionCtx("sess-D"), onDisplayPinned: (id) => pins.push(id) });
      r = await d2("app_ax_find", { app: "org.kde.kate", window_id: "{kate-1}" });
      const k = Math.min(1, 1568 / 2560, Math.sqrt(1150000 / (2560 * 1440))), tw = Math.round(2560 * k), th = Math.round(1440 * k);
      check("kwin 2 monitors: upstream's pin to the window's display", JSON.stringify(pins), "[1]");
      check("kwin 2 monitors: positions in display 1's next-screenshot frame", textOf(r).includes(`"Save" at (${Math.round(120 * tw / 2560)}, ${Math.round(210 * th / 1440)})`) && textOf(r).includes("frame of display 1 (eDP-1), now the current display"), true);
      dims = { width: 1280, height: 720, displayWidth: 2560, displayHeight: 1440, originX: 0, originY: 0, displayId: 1 };
      pins.length = 0;
      r = await d2("app_ax_find", { app: "org.kde.kate", window_id: "{kate-1}" });
      check("kwin: window on the current display, no pin", pins.length + "|" + textOf(r).includes('"Save" at (60, 105)'), "0|true");
      delete kctx2.__linuxExecutor.listDisplays;
      dims = undefined;
    }
    // n. per-session index cache.
    const dispatchB = kexp[DKEY](serverCtx(kctx2.__linuxExecutor), "pixels", sessionCtx("sess-B"));
    r = await dispatchB("app_click", { app: "org.kde.kate", element_index: 3 });
    check("another session: no indexes of session A", textOf(r).includes("No element [3]"), true);
    // o. task boundary of another session: nothing; lock release: restore.
    resetLog();
    kctx2.__linuxExecutor.__cuTaskBoundary("session_X", "renderer", "cse_Y");
    await tick();
    check("boundary of another session: no restore", calls().length, 0);
    check("boundary: executor's own hook still called", JSON.stringify(lockCalls.at(-1)), JSON.stringify(["boundary", "session_X", "renderer", "cse_Y"]));
    const p = kctx2.__linuxExecutor.__setLockHeld(false);
    check("lock release: returns the executor's promise", typeof p?.then, "function");
    await p;
    for (let i = 0; i < 100 && existsSync(statePath); i++) await tick();
    check("lock release: ax-restore --holder-pid <pid>", calls().map((c) => c.argv.join(" ")).join("|"), "ax-restore --holder-pid " + process.pid);
    check("lock release: state file removed", existsSync(statePath), false);
    check("lock release: executor's own hook called", JSON.stringify(lockCalls.at(-1)), JSON.stringify(["lock", false]));
    resetLog();
    await kctx2.__linuxExecutor.__setLockHeld(false);
    await tick();
    check("second release: nothing to restore", calls().length, 0);
    dims = { width: 1280, height: 720, displayWidth: 2560, displayHeight: 1440, originX: 0, originY: 0 };
    await dispatch("app_ax_find", { app: "org.kde.kate" });
    check("after restore: next find enables again", calls().filter((c) => c.argv[0] === "ax-enable").length, 1);
    // Qt/Chromium register a moment after the switch flips: app_not_found on
    // the first find after an enable that changed it is retried once.
    await kctx2.__linuxExecutor.__setLockHeld(false);
    for (let i = 0; i < 50 && existsSync(statePath); i++) await tick();
    resetLog();
    process.env.CDB_FAKE_AX_ONCE = "{kate-1}";
    r = await dispatch("app_ax_find", { app: "org.kde.kate" });
    check("fresh enable: app_not_found retried once", calls().filter((c) => c.argv[0] === "ax-find").length + "|" + !r.isError, "2|true");
    rmSync(logFile + ".once", { force: true });
    resetLog();
    r = await dispatch("app_ax_find", { app: "org.kde.kate" });
    check("later find: app_not_found passed through, no retry", calls().filter((c) => c.argv[0] === "ax-find").length + "|" + textOf(r).startsWith("unavailable: app_not_found"), "1|true");
    delete process.env.CDB_FAKE_AX_ONCE;
    rmSync(logFile + ".once", { force: true });
    resetLog();
    kctx2.__linuxExecutor.__cuTaskBoundary("session_ABC", "stop_click", "cse_abc");
    for (let i = 0; i < 50 && !calls().length; i++) await tick();
    await tick();
    check("boundary of the lock's session: restore", calls().map((c) => c.argv.join(" ")).join("|"), "ax-restore --holder-pid " + process.pid);
    kctx2.__cdbCuAxElements = () => false;
    resetLog();
    r = await dispatch("app_ax_find", { app: "org.kde.kate" });
    check("switched off again: upstream's answer", textOf(r), textOf(await pristineDispatch("app_ax_find", { app: "org.kde.kate" })));
    check("switched off again: zero spawns", calls().length, 0);
    // Exit: the recorded process "exit" handler restores synchronously.
    kctx2.__cdbCuAxElements = () => true;
    await dispatch("app_ax_find", { app: "org.kde.kate" });
    check("state marker present before exit", existsSync(statePath), true);
    resetLog();
    check("exit handler registered once", exitHandlers.length, 1);
    exitHandlers.forEach((fn) => fn());
    check("exit: ax-restore --holder-pid <pid> (sync)", calls().map((c) => c.argv.join(" ")).join("|"), "ax-restore --holder-pid " + process.pid);
    check("exit: marker removed", existsSync(statePath), false);
    kctx2.__cdbCuAxElements = () => false;
    const secrets = ["Save", "Search", "draft", "hunter2", "Hint", "Password", "notes.txt", "Far away", "Async", "Moved", "Back"];
    const leaked = diag.filter((l) => secrets.some((x) => l.includes(x)));
    check("diag lines carry no element names, values or typed text", leaked.length + (leaked[0] ? " " + leaked[0] : ""), "0");
    check("diag lines present and prefixed [claude-cu][ax]", diag.length > 5 && diag.every((l) => l.startsWith("[claude-cu][ax] ")), true);

    // ---------------------------------------------------------------- [5b]
    console.log("\n[5b] idle restore (fake timers)");
    {
      const timers = [];
      let unrefs = 0;
      const ictx = makeCtx({
        userData,
        setTimeout: (fn, ms) => {
          if (ms !== 120000) return setTimeout(fn, ms);
          const t = { fn, ms, cleared: false, unref: () => unrefs++ };
          timers.push(t);
          return t;
        },
        clearTimeout: (t) => (t && t.ms === 120000 ? (t.cleared = true) : clearTimeout(t)),
      });
      ictx.__cuKwinMode = true;
      ictx.__cuKwinBridgeBin = bin;
      ictx.__cdbCuAxElements = () => true;
      loadAx(ictx);
      resetLog();
      await ictx.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "idle" });
      await ictx.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "idle" });
      const live = timers.filter((t) => !t.cleared);
      check("idle: armed 2 min, re-armed per call (one live timer)", timers.length + "|" + live.length, "2|1");
      check("idle: timer unref'd", unrefs >= 2, true);
      resetLog();
      live[0].fn();
      for (let i = 0; i < 100 && existsSync(statePath); i++) await tick();
      check("idle: fires ax-restore", calls().map((c) => c.argv.join(" ")).join("|"), "ax-restore --holder-pid " + process.pid);
      check("idle: marker removed", existsSync(statePath), false);
      // Race: a call queued right behind a restore enables again.
      resetLog();
      await ictx.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "idle" });
      const rp = ictx.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "idle" });
      timers.filter((t) => !t.cleared).at(-1).fn();
      const after = ictx.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "idle" });
      await rp;
      const ra = await after;
      const seq = calls().map((c) => c.argv[0]).filter((a) => a !== "windows").join(",");
      check("race: restore serialized between calls, next call re-enables", seq, "ax-enable,ax-find,ax-find,ax-restore,ax-enable,ax-find");
      check("race: call after restore succeeds", !ra.isError, true);
      timers.filter((t) => !t.cleared).at(-1).fn();
      for (let i = 0; i < 100 && existsSync(statePath); i++) await tick();
    }

    // ---------------------------------------------------------------- [6]
    console.log("\n[6] regular mode through the patched handleToolCall injection");
    const hp = handlerChunk && pristine.get(handlerChunk);
    const hq = handlerChunk && patched.get(handlerChunk);
    const HTC_RE = /handleToolCall:async\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)=>\{/;
    const mP = hp && HTC_RE.exec(hp.slice(hp.search(/isEnabled:[\w$]+=>[\w$]+\.sessionType===["`]ccd["`]\?/)));
    const mQ = hq && HTC_RE.exec(hq.slice(hq.search(/isEnabled:[\w$]+=>[\w$]+\.sessionType===["`]ccd["`]\?/)));
    let injected = null;
    if (mP && mQ) {
      const pStart = hp.search(/isEnabled:[\w$]+=>[\w$]+\.sessionType===["`]ccd["`]\?/) + mP.index + mP[0].length;
      const qStart = hq.search(/isEnabled:[\w$]+=>[\w$]+\.sessionType===["`]ccd["`]\?/) + mQ.index + mQ[0].length;
      const upstreamHead = hp.slice(pStart, pStart + 60);
      const qEnd = hq.indexOf(upstreamHead, qStart);
      injected = qEnd > qStart ? hq.slice(qStart, qEnd) : null;
    }
    check("Patch 6 injection located in the patched handler", !!injected && injected.startsWith('if(process.platform==="linux"&&!globalThis.__cuKwinMode){'), true);
    check("injection carries the accessibility branch", !!injected && injected.includes("__cdbAxHandles(") && readFileSync(HANDLER_JS, "utf8").includes("globalThis.__cdbAxHandles(__TOOL_NAME__)"), true);
    if (injected) {
      const [, sP, nP, iP, seP] = mQ;
      const rctx = makeCtx({ userData });
      const regExec = {
        capabilities: { screenshotFiltering: "none", platform: "linux" },
        __axBridge: () => ({ bin, name: "x11-bridge" }),
        __axToDip: (x, y) => [x / 2, y / 2],
        async __targetCheck() {
          return null;
        },
        async __setLockHeld() {},
        async __cuTaskBoundary() {},
      };
      rctx.__linuxExecutor = regExec;
      rctx.__cuKwinMode = false;
      loadAx(rctx);
      const handler = vm.runInContext(`(async function(${sP},${nP},${iP},${seP}){${injected}return{content:[{type:"text",text:"UPSTREAM"}]}})`, rctx);
      const session = { sessionId: "local-1" };
      resetLog();
      r = await handler({}, "app_ax_find", { app: "mousepad" }, session);
      check("switch off: Unknown tool, as before", textOf(r), "Unknown tool: app_ax_find");
      check("switch off: zero spawns", calls().length, 0);
      rctx.__cdbCuAxElements = () => true;
      // Before any screenshot: the executor's next-screenshot frame is used and
      // installed, so a left_click at the reported point maps the same way.
      const SHOT = { imgW: 1280, imgH: 800, dispW: 1920, dispH: 1200, originX: 0, originY: 0 };
      const frameAsks = [];
      regExec.__axFrameFor = (x, y) => (frameAsks.push([x, y]), { ...SHOT, displayId: 0 });
      r = await handler({}, "app_ax_find", { app: "mousepad" }, session);
      const before = textOf(r).split("\n").slice(1).join("\n");
      check("before a screenshot: positions reported", textOf(r).includes('[2] AXButton (push button) "Open" at (640, 400)'), true);
      check("before a screenshot: frame asked for the element's display (DIP)", JSON.stringify(frameAsks[0]), JSON.stringify([960, 600]));
      check("before a screenshot: frame installed for left_click", JSON.stringify(rctx.__cuLastShot), JSON.stringify(SHOT));
      check("regular: same bridge commands", calls().map((c) => c.argv[0]).join(","), "windows,ax-enable,ax-find");
      // As the screenshot case would set it.
      rctx.__cuLastShot = { ...SHOT };
      r = await handler({}, "app_ax_find", { app: "mousepad" }, session);
      // root px (1920,1200) -> DIP via the executor (/2) -> image (*1280/1920).
      check("regular: root px -> DIP -> screenshot frame", textOf(r).includes('[2] AXButton (push button) "Open" at (640, 400)'), true);
      check("before vs after a screenshot: identical positions", textOf(r).split("\n").slice(1).join("\n"), before);
      check("after a screenshot (one display): its frame is kept", JSON.stringify(rctx.__cuLastShot), JSON.stringify(SHOT));
      r = await handler({}, "app_ax_find", { app: "kate" }, session);
      check("bare name shared by two vendors (org.kde.kate, org.evil.kate): ambiguous", r.isError === true && textOf(r).includes("more than one app") && textOf(r).includes("org.evil.kate"), true);
      r = await handler({}, "app_list_windows", { app: "kate" }, session);
      check("list: same ambiguity refused", r.isError === true && textOf(r).includes("more than one app"), true);
      r = await handler({}, "app_list_windows", { app: "org.kde.kate" }, session);
      check("full id: exact match only", textOf(r).includes("{kate-1}") && !textOf(r).includes("{evil-2}"), true);
      for (const a of ["Mousepad", "org.xfce.mousepad", "org.xfce.mousepad.desktop"]) {
        r = await handler({}, "app_ax_find", { app: a }, session);
        check(`regular: app "${a}" matches desktop id org.xfce.mousepad (last segment)`, !r.isError, true);
      }
      r = await handler({}, "app_click", { app: "mousepad", element_index: 2 }, session);
      check("regular: click, no grant needed (auto-grant)", textOf(r).startsWith("Pressed [2]"), true);
      check("single display: no display pinned", rctx.__cuPinnedDisplay, undefined);
      // Two monitors: Mousepad's window is on display 2 (right of display 1);
      // the last screenshot showed display 1.
      {
        const MONS = [
          { displayId: 1, label: "eDP-1", originX: 0, originY: 0, width: 960, height: 600, isPrimary: true },
          { displayId: 2, label: "DP-3-2", originX: 960, originY: 0, width: 1920, height: 1440 },
        ];
        const rule = (m) => {
          const k = Math.min(1, 1568 / Math.max(m.width, m.height), Math.sqrt(1150000 / (m.width * m.height)));
          return { w: Math.round(m.width * k), h: Math.round(m.height * k) };
        };
        const monAt = (x, y) => MONS.find((m) => x >= m.originX && x < m.originX + m.width && y >= m.originY && y < m.originY + m.height) || MONS[0];
        regExec.__axToDip = (x, y) => [x, y];
        regExec.__axFrameFor = (x, y) => {
          const m = monAt(x, y), t = rule(m);
          return { imgW: t.w, imgH: t.h, dispW: m.width, dispH: m.height, originX: m.originX, originY: m.originY, displayId: m.displayId, label: m.label, count: MONS.length };
        };
        regExec.listDisplays = async () => MONS;
        const shots = [];
        regExec.screenshot = async ({ displayId }) => {
          shots.push(displayId);
          const m = MONS.find((d) => d.displayId === displayId), t = rule(m);
          return { base64: "", mimeType: "image/jpeg", imgW: t.w, imgH: t.h, displayWidth: m.width, displayHeight: m.height, originX: m.originX, originY: m.originY };
        };
        const d1 = rule(MONS[0]);
        rctx.__cuPinnedDisplay = undefined;
        rctx.__cuLastShot = { imgW: d1.w, imgH: d1.h, dispW: 960, dispH: 600, originX: 0, originY: 0 };
        r = await handler({}, "app_ax_find", { app: "mousepad" }, session);
        check("2 monitors: window's display made current", rctx.__cuPinnedDisplay, 2);
        check("2 monitors: result says so", textOf(r).includes("frame of display 2 (DP-3-2), now the current display") && textOf(r).includes("last screenshot showed another display"), true);
        const used = JSON.stringify(rctx.__cuLastShot);
        r = await handler({}, "screenshot", {}, session);
        check("next screenshot captures display 2", shots.at(-1), 2);
        check("screenshot frame equals the frame the positions used", JSON.stringify(rctx.__cuLastShot), used);
        r = await handler({}, "app_ax_find", { app: "mousepad" }, session);
        check("window on the current display: no new switch note", textOf(r).includes("now the current display"), false);
        r = await handler({}, "switch_display", { display: "eDP-1" }, session);
        check("switch_display still pins through the shared function", rctx.__cuPinnedDisplay + "|" + rctx.__cuLastShot, "1|null");
        delete regExec.listDisplays;
        delete regExec.screenshot;
        rctx.__cuPinnedDisplay = undefined;
      }
      check("regular: other tools unchanged", textOf(await handler({}, "list_granted_applications", {}, session)), "All applications are accessible on Linux (no grants needed)");
      rctx.__cuKwinMode = true;
      r = await handler({}, "app_ax_find", { app: "mousepad" }, session);
      check("kwin mode: injection steps aside (upstream dispatches)", textOf(r), "UPSTREAM");
      rctx.__cuKwinMode = false;
      resetLog();
      await rctx.__linuxExecutor.__setLockHeld(false);
      for (let i = 0; i < 50 && !calls().length; i++) await tick();
      await tick();
      check("regular: lock release restores through the executor's bridge", calls().map((c) => c.argv.join(" ")).join("|"), "ax-restore --holder-pid " + process.pid);
    }

    // ---------------------------------------------------------------- [6a]
    console.log("\n[6a] regular mode, ask-before-control on: same coordinates as off");
    if (injected) {
      const [, sP, nP, iP, seP] = mQ;
      const MONS = [
        { displayId: 1, label: "eDP-1", originX: 0, originY: 0, width: 960, height: 600, isPrimary: true },
        { displayId: 2, label: "DP-3-2", originX: 960, originY: 0, width: 1920, height: 1440 },
      ];
      const rule = (m) => {
        const k = Math.min(1, 1568 / Math.max(m.width, m.height), Math.sqrt(1150000 / (m.width * m.height)));
        return { w: Math.round(m.width * k), h: Math.round(m.height * k) };
      };
      const monAt = (x, y) => MONS.find((m) => x >= m.originX && x < m.originX + m.width && y >= m.originY && y < m.originY + m.height) || MONS[0];
      // One run of the same calls; ask = load js/cu_consent.js with the switch on.
      const scenario = async (ask) => {
        const c = makeCtx({ userData });
        const SHOT = { imgW: 1280, imgH: 800, dispW: 1920, dispH: 1200, originX: 0, originY: 0 };
        const exr = {
          capabilities: { screenshotFiltering: "none", platform: "linux" },
          capabilitiesNow: () => ({ screenshotFiltering: "none", hitTest: "native", frontmost: "native", hostBundleId: "com.anthropic.Claude", backend: "x11-bridge" }),
          __axBridge: () => ({ bin, name: "x11-bridge" }),
          __axToDip: (x, y) => [x / 2, y / 2],
          __axFrameFor: () => ({ ...SHOT, displayId: 0 }),
          async __targetCheck() { return null; },
          async __setLockHeld() {},
          async __cuTaskBoundary() {},
        };
        c.__linuxExecutor = exr;
        c.__cuKwinMode = false;
        c.__cdbCuAxElements = () => true;
        if (ask) {
          c.__cdbCuAskBeforeControl = () => true;
          vm.runInContext(readFileSync(CONSENT_JS, "utf8"), c);
        }
        loadAx(c);
        const h = vm.runInContext(`(async function(${sP},${nP},${iP},${seP}){${injected}return{content:[{type:"text",text:"UPSTREAM"}]}})`, c);
        const grants = [{ bundleId: "org.xfce.mousepad", displayName: "Mousepad" }, { bundleId: "org.kde.kate", displayName: "Kate" }];
        const sess = { sessionId: "ask-" + ask, onComputerUsePermissionRequest: async () => ({}), getCuAllowedApps: () => grants, getCuGrantFlags: () => ({}) };
        const out = [];
        // before any screenshot (the predicted frame), then after one
        out.push(textOf(await h({}, "app_ax_find", { app: "mousepad" }, sess)));
        c.__cuLastShot = { ...SHOT };
        out.push(textOf(await h({}, "app_ax_find", { app: "mousepad" }, sess)));
        // app_click refused by the app: the fallback center in the screenshot
        out.push(textOf(await h({}, "app_ax_find", { app: "org.kde.kate" }, sess)));
        out.push(textOf(await h({}, "app_click", { app: "org.kde.kate", element_index: 8 }, sess)));
        // two monitors: the window's display becomes current through opts.pin
        exr.__axToDip = (x, y) => [x, y];
        exr.__axFrameFor = (x, y) => {
          const m = monAt(x, y), t = rule(m);
          return { imgW: t.w, imgH: t.h, dispW: m.width, dispH: m.height, originX: m.originX, originY: m.originY, displayId: m.displayId, label: m.label, count: MONS.length };
        };
        exr.listDisplays = async () => MONS;
        const d1 = rule(MONS[0]);
        c.__cuPinnedDisplay = undefined;
        c.__cuLastShot = { imgW: d1.w, imgH: d1.h, dispW: 960, dispH: 600, originX: 0, originY: 0 };
        out.push(textOf(await h({}, "app_ax_find", { app: "mousepad" }, sess)));
        out.push("pinned=" + c.__cuPinnedDisplay + " shot=" + JSON.stringify(c.__cuLastShot));
        // and an app the session did not approve
        const refused = await h({}, "app_ax_find", { app: "org.kde.dolphin" }, sess);
        // Leave like a lock release: the next scenario's context must not
        // find this one's accessibility marker at its start.
        await exr.__setLockHeld(false);
        for (let i = 0; i < 100 && existsSync(join(userData, "cdb-ax-state.json")); i++) await tick();
        return { out, refused };
      };
      const off = await scenario(false);
      const on = await scenario(true);
      const labels = ["before a screenshot", "after a screenshot", "kate find", "app_click fallback center", "2 monitors: find", "2 monitors: pin + frame"];
      for (let i = 0; i < labels.length; i++) check("R3: switch on = off: " + labels[i], on.out[i], off.out[i]);
      check("R3: on: positions are reported (not 'unknown')", on.out[0].includes('"Open" at (640, 400)'), true);
      check("R3: on: the app_click fallback names the center", /left_click there instead/.test(on.out[3]), true);
      check("R3: on: the 2-monitor pin happened", /pinned=2 /.test(on.out[5]), true);
      check("R3: on: an unapproved app is refused", on.refused.isError === true && /not in the allowed applications/.test(textOf(on.refused)), true);
      check("R3: off: no grant check", off.refused.isError === true && /not in the allowed applications/.test(textOf(off.refused)), false);
    }

    // ---------------------------------------------------------------- [6b]
    console.log("\n[6b] GNOME: no window list, the bridge resolves by app id + title");
    {
      const gctx = makeCtx({ userData });
      gctx.__linuxExecutor = { capabilities: { platform: "linux" }, __axBridge: () => ({ bin, name: "gnome-portal-bridge" }), async __setLockHeld() {}, async __cuTaskBoundary() {} };
      gctx.__cuKwinMode = false;
      gctx.__cdbCuAxElements = () => true;
      loadAx(gctx);
      const g = (n, a) => gctx.__cdbAxCall(n, a, { sid: "g1" });
      resetLog();
      r = await g("app_list_windows", { app: "org.gnome.TextEditor" });
      let gl = [];
      try { gl = JSON.parse(textOf(r).split("]")[0] + "]"); } catch {}
      check("list: ambiguous -> candidate titles as windows", gl.map((w) => w.window_id).join(","), "notes.txt,todo.md");
      check("list: says GNOME lists by title", textOf(r).includes("GNOME lists windows by title"), true);
      check("list: no `windows` call, app-id find", calls().map((c) => c.argv.join(" ")).filter((x) => !x.startsWith("ax-enable")).join("|"), "ax-find --app-id org.gnome.TextEditor");
      r = await g("app_list_windows", { app: "org.gnome.Calculator" });
      check("list: single matched window", textOf(r).startsWith('[{"window_id":"Calculator","title":"Calculator","is_main":true'), true);
      r = await g("app_ax_find", { app: "org.gnome.TextEditor" });
      check("find without window_id: ambiguous passed through with candidates", r.isError === true && textOf(r).includes("ambiguous_window") && textOf(r).includes('"todo.md"'), true);
      resetLog();
      r = await g("app_ax_find", { app: "org.gnome.TextEditor", window_id: "notes.txt" });
      check("find: --app-id + --title", calls().map((c) => c.argv.join(" ")).join("|"), "ax-find --app-id org.gnome.TextEditor --title notes.txt");
      check("find: window shown by title", textOf(r).includes('window "notes.txt" (window_id notes.txt)') && textOf(r).includes('[4] AXButton (push button) "Open"'), true);
      resetLog();
      r = await g("app_click", { app: "org.gnome.TextEditor", element_index: 4 });
      check("click without window_id: last searched title, scope + ref", textOf(r).startsWith("Pressed [4]") && calls().map((c) => c.argv.join(" ")).join("|") === "ax-action --scope sc-te --ref te-open --action click", true);
      r = await g("app_click", { app: "org.gnome.TextEditor", window_id: "todo.md", element_index: 4 });
      check("other title: no indexes of notes.txt", textOf(r).includes("No element [4]"), true);
      r = await g("app_click", { app: "org.gnome.Calculator", element_index: 2 });
      check("no find yet: find first", textOf(r).includes("No element [2]"), true);
      check("never a `windows` call on GNOME", calls().some((c) => c.argv[0] === "windows"), false);
      resetLog();
      await g("app_ax_find", { app: "org.gnome.TextEditor.desktop", window_id: "notes.txt" });
      check("app id: .desktop stripped", calls().map((c) => c.argv.join(" ")).join("|"), "ax-find --app-id org.gnome.TextEditor --title notes.txt");
      r = await g("app_type", { app: "org.gnome.TextEditor", window_id: "notes.txt", element_index: 5, text: "x" });
      check("bridge exit 2 (usage): clean tool error, not a crash", r.isError === true && textOf(r).includes("failed (exit 2)") && textOf(r).includes("not valid UTF-8"), true);
      // Stop-sharing latch (#293): input-like AX actions refused, reading allowed.
      gctx.__linuxExecutor.__stoppedByUser = () => true;
      resetLog();
      r = await g("app_click", { app: "org.gnome.TextEditor", window_id: "notes.txt", element_index: 4 });
      check("stopped sharing: app_click refused", r.isError === true && textOf(r).includes("stopped screen sharing"), true);
      r = await g("app_type", { app: "org.gnome.TextEditor", window_id: "notes.txt", element_index: 5, text: "x" });
      check("stopped sharing: app_type refused", r.isError === true && textOf(r).includes("stopped screen sharing"), true);
      check("stopped sharing: no ax-action spawned", calls().some((c) => c.argv[0] === "ax-action"), false);
      r = await g("app_ax_find", { app: "org.gnome.TextEditor", window_id: "notes.txt" });
      check("stopped sharing: app_ax_find still works", !r.isError, true);
      r = await g("app_list_windows", { app: "org.gnome.Calculator" });
      check("stopped sharing: app_list_windows still works", !r.isError, true);
      gctx.__linuxExecutor.__stoppedByUser = () => false;
      r = await g("app_click", { app: "org.gnome.TextEditor", window_id: "notes.txt", element_index: 4 });
      check("latch lifted: click works again", textOf(r).startsWith("Pressed [4]"), true);
      await gctx.__linuxExecutor.__setLockHeld(false);
      for (let i = 0; i < 100 && existsSync(statePath); i++) await tick();
    }

    // ---------------------------------------------------------------- [6c]
    console.log("\n[6c] wlroots: expected window identity; every bridge: app pid check");
    {
      const wctx = makeCtx({ userData });
      wctx.__linuxExecutor = { capabilities: { platform: "linux" }, __axBridge: () => ({ bin, name: "wlroots-bridge" }), async __setLockHeld() {}, async __cuTaskBoundary() {} };
      wctx.__cuKwinMode = false;
      wctx.__cdbCuAxElements = () => true;
      loadAx(wctx);
      const w = (n, a) => wctx.__cdbAxCall(n, a, { sid: "w1" });
      resetLog();
      r = await w("app_ax_find", { app: "foot" });
      check("wlroots: --expect-app-id / --expect-title from the picked window", calls().map((c) => c.argv.join(" ")).filter((x) => x.startsWith("ax-find")).join("|"), "ax-find --window {wl-1} --expect-app-id foot --expect-title ~ - foot");
      check("wlroots: find ok", !r.isError, true);
      r = await w("app_ax_find", { app: "org.gnome.Nautilus" });
      check("window_changed: tell the model to list windows again", r.isError === true && textOf(r).startsWith("unavailable: window_changed") && textOf(r).includes("app_list_windows again"), true);
      r = await w("app_ax_find", { app: "pidapp" });
      check("app pid differs from the window's pid: refused", r.isError === true && textOf(r).startsWith("unavailable: app_not_confirmed"), true);
      const xctx = makeCtx({ userData });
      xctx.__linuxExecutor = { capabilities: { platform: "linux" }, __axBridge: () => ({ bin, name: "x11-bridge" }), async __setLockHeld() {}, async __cuTaskBoundary() {} };
      xctx.__cdbCuAxElements = () => true;
      loadAx(xctx);
      resetLog();
      r = await xctx.__cdbAxCall("app_ax_find", { app: "pidapp" }, { sid: "x1" });
      check("x11 too: pid mismatch refused, no --expect-* flags", r.isError === true && calls().filter((c) => c.argv[0] === "ax-find").every((c) => !c.argv.includes("--expect-title")), true);
      // Both contexts restore (each holds its own enable); wait for both, or
      // the later one's marker removal lands on the file [7] writes.
      resetLog();
      for (const c of [wctx, xctx]) await c.__linuxExecutor.__setLockHeld(false);
      for (let i = 0; i < 100 && calls().filter((c) => c.argv[0] === "ax-restore").length < 2; i++) await tick();
      await tick();
    }

    // ---------------------------------------------------------------- [7]
    console.log("\n[7] start: crash recovery");
    resetLog();
    writeFileSync(statePath, JSON.stringify({ previous: false, changed: true, at: 1 }));
    const sctx = makeCtx({ userData });
    sctx.__cuKwinMode = true;
    sctx.__cuKwinBridgeBin = bin;
    loadAx(sctx);
    for (let i = 0; i < 50 && existsSync(statePath); i++) await tick();
    check("state file at start (switch off): restored", calls().map((c) => c.argv.join(" ")).join("|"), "ax-restore --holder-pid " + process.pid);
    check("state file removed", existsSync(statePath), false);
    resetLog();
    const s2 = makeCtx({ userData });
    s2.__cuKwinMode = true;
    s2.__cuKwinBridgeBin = bin;
    loadAx(s2);
    await tick();
    await tick();
    check("no state file, switch off: nothing spawned at start", calls().length, 0);

    // ---------------------------------------------------------------- [8]
    // ax-cli: the bridge's accessibility features are asked once per bridge
    // binary (`ax-features`); a bridge without the subcommand (exit 2), any
    // other failure and a wrong shape all mean the legacy (empty) list.
    console.log("\n[8] ax-features negotiation");
    const featLog = logFile + ".features";
    const featCalls = () =>
      existsSync(featLog) ? readFileSync(featLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const ALL_FEATURES = ["find.v1", "action.click", "action.focus", "action.set_text", "find.identity", "action.expect", "find.window_ref", "find.deadline", "find.root", "find.skeleton", "action.ensure", "action.scroll_to", "action.set_value"];
    const setFeatures = (f) => {
      if (f === undefined) delete process.env.CDB_FAKE_AX_FEATURES;
      else process.env.CDB_FAKE_AX_FEATURES = typeof f === "string" ? f : JSON.stringify({ ax_features: f });
    };
    // A regular-mode context on the fake bridge under `name`.
    const axCtx = (name, extra = {}) => {
      const d = extra.diag || [];
      const c = makeCtx({ userData, diag: d, setTimeout: extra.setTimeout, clearTimeout: extra.clearTimeout });
      c.__linuxExecutor = { capabilities: { platform: "linux" }, __axBridge: () => ({ bin, name }), async __setLockHeld() {}, async __cuTaskBoundary() {}, ...(extra.executor || {}) };
      c.__cuKwinMode = false;
      c.__cdbCuAxElements = () => true;
      loadAx(c);
      c.__diag = d;
      return c;
    };
    const releaseAx = async (c) => {
      await c.__linuxExecutor.__setLockHeld(false);
      for (let i = 0; i < 100 && existsSync(statePath); i++) await tick();
    };
    {
      setFeatures(undefined);
      rmSync(featLog, { force: true });
      const lc = axCtx("x11-bridge");
      resetLog();
      await lc.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "f1" });
      await lc.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "f1" });
      r = await lc.__cdbAxCall("app_click", { app: "org.kde.kate", element_index: 3 }, { sid: "f1" });
      check("legacy: ax-features asked once per bridge binary", featCalls().length, 1);
      check("legacy: probe takes no flags and no stdin", JSON.stringify(featCalls()[0]), JSON.stringify({ argv: ["ax-features"], stdin: "" }));
      check("legacy: exit 2 -> no features (diag)", lc.__diag.some((l) => l.includes("features: none")), true);
      check("legacy: click as today", textOf(r).startsWith("Pressed [3]") && calls().map((c) => c.argv.join(" ")).includes("ax-action --scope sc-kate --ref :1.42/org/a11y/atspi/accessible/3 --action click"), true);
      check("legacy: probe never in the command log", calls().some((c) => c.argv[0] === "ax-features"), false);
      await releaseAx(lc);
      const outcomes = [
        ["v2 list", ALL_FEATURES, "features: " + ALL_FEATURES.join(",")],
        ["wrong shape (string)", '{"ax_features":"find.v1"}', "features: none"],
        ["wrong shape (non-string entry)", '{"ax_features":["find.v1",3]}', "features: none"],
        ["not JSON", "find.v1", "features: none"],
        ["exit 1", "__exit1", "features: none"],
      ];
      for (const [label, f, want] of outcomes) {
        setFeatures(f);
        rmSync(featLog, { force: true });
        const c = axCtx("x11-bridge");
        await c.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "f2" });
        await c.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "f2" });
        check(`${label}: asked once, diag "${want.slice(0, 40)}"`, featCalls().length + "|" + c.__diag.some((l) => l.includes(want)), "1|true");
        await releaseAx(c);
      }
      setFeatures(ALL_FEATURES);
      rmSync(featLog, { force: true });
      const oc = axCtx("x11-bridge");
      oc.__cdbCuAxElements = () => false;
      resetLog();
      const offTools = oc.__cdbAxTools({ platform: "linux" });
      const offKey = oc.__cdbAxKey();
      check("switch off: no tools, no key, nothing spawned (no probe either)", JSON.stringify(offTools) + "|" + offKey + "|" + calls().length + "|" + featCalls().length, "[]||0|0");
      setFeatures(undefined);
    }

    // ---------------------------------------------------------------- [9]
    // ax-refs: [N] is allocated once per accessible object and reused; actions
    // carry the element's identity (--expect-json); a re-created element is
    // re-identified only under the strict rule; delivery decides the wording.
    console.log("\n[9] stable [N], identity check, delivery, re-identification");
    const fixFile2 = join(scratch, "fixture-v2.json");
    const resetSeq = () => {
      for (const f of readdirSync(scratch)) if (f.startsWith("bridge.log.seq.")) rmSync(join(scratch, f));
    };
    const AXR = { "push button": "AXButton", text: "AXTextField", "check box": "AXCheckBox", slider: "AXSlider", "spin button": "AXIncrementor", panel: "AXGroup", filler: "AXGroup", "page tab": "AXRadioButton" };
    const vEl = (index, role, name, ref, extra = {}) => ({
      index, ax_role: AXR[role] || "AXUnknown", role, name, ref,
      states: ["enabled", "sensitive", "showing", "visible"], actions: ["click"],
      accessible_id: null, depth: 2, parent_index: null, path: [0, index], unique: true,
      rect_screen: { x: 100 + index * 10, y: 200, width: 20, height: 20 },
      ...extra,
    });
    const KATE_WIN = { id: "{kate-1}", title: "notes.txt - Kate", ref: ":1.42/w", frame_class: "global_frame" };
    const kateFind = (elements, extra = {}) => ({ app: { name: "kate", pid: 1111 }, window: KATE_WIN, coords: "screen", scope: "sc-kate2", matched_by: "pid", truncated: false, total_seen: 60, elements, ...extra });
    const V_A = [
      vEl(3, "push button", "Save", "r-save", { accessible_id: "save-btn" }),
      vEl(5, "text", "Search", "r-search", { states: ["enabled", "editable"] }),
      vEl(12, "check box", "Word wrap", "r-wrap"),
      vEl(13, "push button", "OK", "ok-1", { unique: false }),
      vEl(14, "push button", "OK", "ok-2", { unique: false }),
      vEl(15, "password text", "Password", "pw2", { ax_role: "AXSecureTextField", states: ["editable"], value_redacted: true }),
      vEl(16, "terminal", "Terminal", "term"),
      vEl(17, "push button", "", "term-child", { parent_index: 16 }),
      vEl(18, "push button", "Apply", "apply-1", { accessible_id: "apply" }),
      vEl(19, "push button", "Close", "close-1"),
      vEl(20, "push button", "Twin", "twin-1"),
      vEl(21, "push button", "", "nameless-1"),
      vEl(22, "push button", "Gone", "gone-1"),
      vEl(23, "push button", "Sent", "sentu-1"),
      vEl(24, "push button", "Boom", "boom-1"),
      vEl(25, "push button", "Nope", "nope-1"),
      vEl(26, "push button", "NoAct", "noact-1"),
    ];
    // The tree changed: a new control in front shifts every BFS index.
    const V_A2 = [vEl(3, "push button", "New", "r-new"), ...V_A.map((e) => ({ ...e, index: e.index + 1 }))];
    // The full re-find after a re-creation.
    const V_B = [
      ...V_A.filter((e) => !["apply-1", "close-1", "twin-1", "gone-1", "nameless-1"].includes(e.ref)),
      vEl(40, "push button", "Apply", "apply-2", { accessible_id: "apply" }),
      vEl(41, "push button", "Close", "close-2"),
      vEl(42, "push button", "Twin", "twin-2", { unique: false }),
      vEl(43, "push button", "Twin", "twin-3", { unique: false }),
    ];
    const ST = (delivery) => ({ unavailable: "stale_element", hint: "The element is gone.", delivery });
    const OKA = (action) => ({ ok: true, action, method: "action:click", delivery: "sent", post: { focused: false } });
    const FIX2 = {
      ...FIXTURE,
      "ax-find": {
        ...FIXTURE["ax-find"],
        "{kate-1}": { __seq: [kateFind(V_A), kateFind(V_A2)] },
        "{kate-1}|all": kateFind(V_B),
        "{dolphin-1}": { app: { name: "dolphin", pid: 2222 }, window: { id: "{dolphin-1}", title: "Home - Dolphin", ref: ":1.50/w" }, coords: "window_only", scope: "sc-dol2", matched_by: "pid", truncated: false, total_seen: 3, elements: [vEl(2, "push button", "Up", "up-1", { accessible_id: "up" })] },
        "{dolphin-1}|all": { app: { name: "dolphin", pid: 9999 }, window: { id: "{dolphin-1}", title: "Home - Dolphin", ref: ":1.50/w" }, coords: "window_only", scope: "sc-dol3", matched_by: "pid", truncated: false, total_seen: 3, elements: [vEl(2, "push button", "Up", "up-2", { accessible_id: "up" })] },
        "{gedit-1}": { app: { name: "gedit" }, window: { id: "{gedit-1}", title: "gedit", ref: ":1.77/w" }, coords: "window_only", scope: "sc-big", matched_by: "app_id", truncated: false, total_seen: 4100, elements: Array.from({ length: 4100 }, (_, i) => vEl(i, "push button", "b" + i, "big-" + i)) },
      },
      "ax-action": {
        ...FIXTURE["ax-action"],
        "r-save": OKA("click"),
        "r-search": { ok: true, action: "set_text", method: "set_text_contents", delivery: "sent" },
        "apply-1": ST("not_sent"),
        "apply-2": OKA("click"),
        "close-1": { unavailable: "element_changed", hint: "The element at this ref is no longer the one that was listed.", delivery: "not_sent" },
        "close-2": OKA("click"),
        "twin-1": ST("not_sent"),
        "nameless-1": ST("not_sent"),
        "gone-1": ST("not_sent"),
        "sentu-1": ST("sent_unverified"),
        "boom-1": { __exit: 1, stderr: "error: ax-action timed out\n" },
        "nope-1": { ok: false, action: "click", method: "action:click", delivery: "sent" },
        "noact-1": { unavailable: "no_action", hint: "No click-like action.", delivery: "not_sent" },
        "ok-1": { unavailable: "element_changed", hint: "changed", delivery: "not_sent" },
        "pw2": { unavailable: "element_changed", hint: "changed", delivery: "not_sent" },
        "term-child": ST("not_sent"),
        "up-1": ST("not_sent"),
      },
    };
    writeFileSync(fixFile2, JSON.stringify(FIX2));
    const useFix = (f) => {
      process.env.CDB_FAKE_AX_FIX = f;
      resetSeq();
    };
    const argvs = () => calls().map((c) => c.argv.join(" "));
    const acts = () => calls().filter((c) => c.argv[0] === "ax-action");
    {
      useFix(fixFile2);
      setFeatures(ALL_FEATURES);
      const vc = axCtx("x11-bridge");
      const v = (n, a, sid = "v1") => vc.__cdbAxCall(n, a, { sid });
      vc.__cuLastShot = { imgW: 1000, imgH: 1000, dispW: 1000, dispH: 1000, originX: 0, originY: 0 };
      check("key: :cdb-ax2 (plus the offered v2 shape)", vc.__cdbAxKey().startsWith(":cdb-ax2"), true);
      resetLog();
      r = await v("app_ax_find", { app: "org.kde.kate" });
      check("v2 find: first find has no --window-ref", argvs().filter((x) => x.startsWith("ax-find")).join("|"), "ax-find --window {kate-1}");
      check("v2 find: [N] = the bridge's index on a fresh window", textOf(r).includes('[3] AXButton (push button) "Save"') && textOf(r).includes('[26] AXButton (push button) "NoAct"'), true);
      resetLog();
      r = await v("app_ax_find", { app: "org.kde.kate" });
      check("later find of a known window: --window-ref <window.ref>", argvs().filter((x) => x.startsWith("ax-find")).join("|"), "ax-find --window {kate-1} --window-ref :1.42/w");
      check("stable [N]: Save keeps [3] although its index moved to 4", textOf(r).includes('[3] AXButton (push button) "Save"') && !textOf(r).includes('[4] AXButton (push button) "Save"'), true);
      check("stable [N]: Search keeps [5]", textOf(r).includes('[5] AXTextField (text) "Search"'), true);
      check("stable [N]: a new control gets a number never used before ([27])", textOf(r).includes('[27] AXButton (push button) "New"'), true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 3 });
      check("click: --expect-json on the action", acts().map((c) => c.argv.join(" ")).join("|"), "ax-action --scope sc-kate2 --ref r-save --action click --expect-json");
      check("click: stdin is the identity of the listed element", acts()[0]?.stdin, JSON.stringify({ expect: { role: "push button", name: "Save", accessible_id: "save-btn" } }));
      check("click: pressed [3]", textOf(r).startsWith("Pressed [3] AXButton (push button)"), true);
      resetLog();
      r = await v("app_type", { app: "org.kde.kate", element_index: 5, text: "hello there" });
      check("type: text inside the JSON on stdin, never argv", acts()[0]?.stdin + "|" + acts()[0]?.argv.includes("hello there"), JSON.stringify({ expect: { role: "text", name: "Search", accessible_id: null }, text: "hello there" }) + "|false");
      check("type: done", textOf(r).startsWith("Set the text of [5]"), true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 18 });
      check("stale (not sent) + accessible id: one re-find, then the new element", argvs().join("|"), "windows|ax-action --scope sc-kate2 --ref apply-1 --action click --expect-json|ax-find --window {kate-1} --all --include-hidden --max-nodes 2000 --window-ref :1.42/w|ax-action --scope sc-kate2 --ref apply-2 --action click --expect-json");
      check("re-identified: second action carries the live identity", acts()[1]?.stdin, JSON.stringify({ expect: { role: "push button", name: "Apply", accessible_id: "apply" } }));
      check("re-identified: the result says so, same [N]", !r.isError && textOf(r).startsWith("Pressed [18]") && /re-identified/.test(textOf(r)), true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 18 });
      check("re-identified [18] now names the new element", acts().map((c) => c.argv[4]).join(), "apply-2");
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 19 });
      check("element_changed + unique role and name: re-identified", acts().map((c) => c.argv[4]).join() + "|" + /re-identified/.test(textOf(r)) + "|" + !r.isError, "close-1,close-2|true|true");
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 20 });
      check("unique at capture but two live matches: refused as ambiguous, nothing sent", r.isError === true && /ambiguous/i.test(textOf(r)) && /nothing was sent/i.test(textOf(r)) && acts().length === 1 && calls().filter((c) => c.argv[0] === "ax-find").length === 1, true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 21 });
      check("unnamed without an id: refused as gone, no re-find", r.isError === true && /gone/.test(textOf(r)) && calls().filter((c) => c.argv[0] === "ax-find").length === 0, true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 22 });
      check("no live match: gone, nothing sent, one re-find", r.isError === true && /gone/.test(textOf(r)) && /nothing was sent/i.test(textOf(r)) && calls().filter((c) => c.argv[0] === "ax-find").length === 1, true);
      r = await v("app_click", { app: "org.kde.kate", element_index: 22 });
      check("gone [22] is retired", textOf(r).includes("No element [22]"), true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 23 });
      check("stale after sending (sent_unverified): never retried", acts().length + "|" + calls().filter((c) => c.argv[0] === "ax-find").length, "1|0");
      check("sent_unverified: 'not confirmed, do not repeat blindly'", /not confirmed/.test(textOf(r)) && /do not repeat it blindly/i.test(textOf(r)), true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 24 });
      check("exit 1: sent_unverified wording, not retried", r.isError === true && /not confirmed/.test(textOf(r)) && /do not repeat it blindly/i.test(textOf(r)) && acts().length === 1, true);
      r = await v("app_click", { app: "org.kde.kate", element_index: 25 });
      check("ok:false (sent): the app did not accept", r.isError === true && /did not accept/.test(textOf(r)), true);
      r = await v("app_click", { app: "org.kde.kate", element_index: 26 });
      check("unavailable not_sent: 'nothing was sent, safe to retry' + left_click fallback", r.isError === true && /nothing was sent, safe to retry/i.test(textOf(r)) && /left_click there instead/.test(textOf(r)), true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 13 });
      check("not unique at capture: no re-identification, no re-find", r.isError === true && calls().filter((c) => c.argv[0] === "ax-find").length === 0, true);
      resetLog();
      r = await v("app_type", { app: "org.kde.kate", element_index: 15, text: "pw", overwrite_existing: true });
      check("redacted element: never re-identified", r.isError === true && calls().filter((c) => c.argv[0] === "ax-find").length === 0, true);
      resetLog();
      r = await v("app_click", { app: "org.kde.kate", element_index: 17 });
      check("terminal-tainted element: never re-identified", r.isError === true && calls().filter((c) => c.argv[0] === "ax-find").length === 0, true);
      check("terminal-tainted: identity sent as printed (no name, no id)", acts()[0]?.stdin, JSON.stringify({ expect: { role: "push button", name: "", accessible_id: null } }));
      await v("app_ax_find", { app: "org.kde.dolphin" });
      resetLog();
      r = await v("app_click", { app: "org.kde.dolphin", element_index: 2 });
      check("re-find sees another process: refused, nothing re-sent", r.isError === true && acts().length === 1 && /app_not_confirmed|another process/.test(textOf(r)), true);
      r = await v("app_click", { app: "org.kde.kate", element_index: 3 }, "v-other");
      check("another session's [N] is unknown", textOf(r).includes("No element [3]"), true);
      // Window LRU: 64 windows across sessions; the 65th evicts the oldest.
      await v("app_ax_find", { app: "org.kde.kate" }, "lru-0");
      for (let i = 1; i <= 64; i++) await v("app_ax_find", { app: "org.kde.kate" }, "lru-" + i);
      r = await v("app_click", { app: "org.kde.kate", element_index: 3 }, "lru-0");
      check("window LRU (64): the oldest window's numbers are dropped", textOf(r).includes("No element [3]"), true);
      r = await v("app_click", { app: "org.kde.kate", element_index: 3 }, "lru-64");
      check("window LRU: a recent window keeps its numbers", textOf(r).includes("No element [3]"), false);
      // Element LRU: 4000 per window.
      await v("app_ax_find", { app: "org.gnome.gedit" });
      r = await v("app_click", { app: "org.gnome.gedit", element_index: 99 });
      const r100 = await v("app_click", { app: "org.gnome.gedit", element_index: 100 });
      check("element LRU (4000): the oldest elements are dropped", textOf(r).includes("No element [99]") + "|" + textOf(r100).includes("No element [100]"), "true|false");
      // Restore (task boundary of the lock's session) and lock release clear.
      await v("app_ax_find", { app: "org.kde.kate" });
      vc.__linuxExecutor.__cuTaskBoundary(null, "stop_click", null);
      for (let i = 0; i < 100 && existsSync(statePath); i++) await tick();
      r = await v("app_click", { app: "org.kde.kate", element_index: 3 });
      check("restore clears the numbers", textOf(r).includes("No element [3]"), true);
      await v("app_ax_find", { app: "org.kde.kate" });
      await vc.__linuxExecutor.__setLockHeld(false);
      r = await v("app_click", { app: "org.kde.kate", element_index: 3 });
      check("lock release clears the numbers", textOf(r).includes("No element [3]"), true);
      const tools = vc.__cdbAxTools({ platform: "linux" });
      check("app_ax_find text: [N] stays the same for the same control", /stays the same/.test(tools.find((t) => t.name === "app_ax_find")?.description || ""), true);
      const vsecrets = ["Save", "Search", "hello there", "Word wrap", "Password", "Apply", "Close", "Twin", "Gone", "save-btn"];
      const vleak = vc.__diag.filter((l) => vsecrets.some((x) => l.includes(x)));
      check("v2 diag lines carry no element names, ids or typed text", vleak.length + (vleak[0] ? " " + vleak[0] : ""), "0");
      await releaseAx(vc);
      setFeatures(undefined);
      useFix(fixFile);
    }
    // Legacy: a stale element may have been acted on (derived sent_unverified).
    {
      const lc = axCtx("x11-bridge");
      await lc.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "l9" });
      r = await lc.__cdbAxCall("app_click", { app: "org.kde.kate", element_index: 7 }, { sid: "l9" });
      check("legacy stale: gone, find again, and it may have been sent", /is gone/.test(textOf(r)) && /app_ax_find again/.test(textOf(r)) && /not confirmed/.test(textOf(r)), true);
      await releaseAx(lc);
    }

    // ---------------------------------------------------------------- [10]
    // ax-wait: wait_for on app_ax_find polls one-shot finds, each its own
    // serial-queue item with the sleep outside the queue. Fake timers: every
    // wait sleep (400..800 ms) resolves at once and is recorded.
    console.log("\n[10] wait_for on app_ax_find");
    const KATE2_WIN = { id: "{kate-2}", title: "other - Kate", ref: ":1.42/w2", frame_class: "global_frame" };
    const k2 = (elements, extra = {}) => ({ app: { name: "kate", pid: 1111 }, window: KATE2_WIN, coords: "window_only", scope: "sc-k2", matched_by: "pid", truncated: false, total_seen: 9, elements, ...extra });
    const BOX = (states, extra = {}) => vEl(4, "check box", "Spell check", "r-box", { states: ["enabled", "showing", ...states], ...extra });
    const FIX3 = {
      ...FIX2,
      "ax-find": {
        ...FIX2["ax-find"],
        "{kate-2}": { __seq: [k2([]), k2([]), k2([vEl(7, "push button", "Done", "r-done")])] },
        "{kate-2}|all": { __seq: [k2([BOX([])]), k2([BOX([])]), k2([BOX(["checked"])])] },
        "{kate-2}|role:check box": k2([BOX([])]),
      },
    };
    const fixFile3 = join(scratch, "fixture-wait.json");
    writeFileSync(fixFile3, JSON.stringify(FIX3));
    const FIX_EMPTY = { ...FIX2, "ax-find": { ...FIX2["ax-find"], "{kate-2}": k2([]), "{kate-2}|all": k2([vEl(4, "text", "Notes", "r-notes", { value: "draft text", states: ["editable"] }), vEl(5, "password text", "PIN", "r-pin", { value_redacted: true, states: ["editable"] })]) } };
    FIX_EMPTY["ax-find"]["{kate-2}|role:fields"] = FIX_EMPTY["ax-find"]["{kate-2}|all"];
    const fixFile4 = join(scratch, "fixture-wait-empty.json");
    writeFileSync(fixFile4, JSON.stringify(FIX_EMPTY));
    // Fake timers: wait sleeps resolve on the next macrotask; onSleep runs first.
    const waitCtx = (name, onSleep) => {
      const sleeps = [];
      const c = axCtx(name, {
        setTimeout: (fn, ms) => {
          if (ms >= 1 && ms <= 800 && ms !== 500) {
            sleeps.push(ms);
            if (onSleep) onSleep.fn?.(sleeps.length);
            return setTimeout(fn, 0);
          }
          if (ms === 500) {
            sleeps.push(ms);
            if (onSleep) onSleep.fn?.(sleeps.length);
            return setTimeout(fn, 0);
          }
          return setTimeout(fn, ms);
        },
      });
      c.__sleeps = sleeps;
      return c;
    };
    const finds = () => calls().filter((c) => c.argv[0] === "ax-find");
    {
      setFeatures(ALL_FEATURES);
      useFix(fixFile3);
      const hooks = {};
      const wc = waitCtx("x11-bridge", hooks);
      const w = (a, opts = {}) => wc.__cdbAxCall("app_ax_find", { app: "org.kde.kate", window_id: "{kate-2}", ...a }, { sid: "w1", ...opts });
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } });
      check("appears: met on the third poll", !r.isError && /^wait_for appears: met after \d+ ms/.test(textOf(r)) && textOf(r).includes('[7] AXButton (push button) "Done"'), true);
      check("appears: three finds, 400 then 500 ms between them (backoff)", finds().length + "|" + wc.__sleeps.join(","), "3|400,500");
      check("find.deadline: each poll passes --deadline-ms", finds().every((c) => c.argv.includes("--deadline-ms")), true);
      useFix(fixFile3);
      wc.__sleeps.length = 0;
      // The window's table already numbers "Done": the box gets the next number.
      const boxN = Number((/\[(\d+)\] AXCheckBox/.exec(textOf(await wc.__cdbAxCall("app_ax_find", { app: "org.kde.kate", window_id: "{kate-2}", role: "check box" }, { sid: "w1" }))) || [])[1]);
      resetLog();
      r = await w({ wait_for: { until: "checked", element_index: boxN, timeout_ms: 5000 } });
      check("checked on the box: met after polls, list with its stable [N]", !r.isError && /^wait_for checked: met after/.test(textOf(r)) && textOf(r).includes(`[${boxN}] AXCheckBox (check box) "Spell check" (checked)`), true);
      check("checked: element waits walk the whole window (--all)", finds().every((c) => c.argv.includes("--all")), true);
      useFix(fixFile4);
      wc.__sleeps.length = 0;
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 2000 } });
      check("timeout: not an error, says timed out with the last observation", !r.isError && /^wait_for appears: timed out after \d+ ms/.test(textOf(r)) && /last observation/.test(textOf(r)), true);
      check("timeout: bounded polls, sleeps sum within the timeout", finds().length >= 3 && wc.__sleeps.reduce((a, b) => a + b, 0) <= 2000, true);
      wc.__sleeps.length = 0;
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 999999 } });
      check("timeout capped at 15000 ms", /timed out/.test(textOf(r)) && wc.__sleeps.reduce((a, b) => a + b, 0) <= 15000 && wc.__sleeps.reduce((a, b) => a + b, 0) >= 10000, true);
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "gone", timeout_ms: 2000 } });
      check("gone: met at once when nothing matches", !r.isError && /^wait_for gone: met after/.test(textOf(r)) && finds().length === 1, true);
      const ft = textOf(await wc.__cdbAxCall("app_ax_find", { app: "org.kde.kate", window_id: "{kate-2}", role: "fields" }, { sid: "w1" }));
      const notesN = Number((/\[(\d+)\] AXTextField \(text\) "Notes"/.exec(ft) || [])[1]);
      const pinN = Number((/\[(\d+)\] [\w]+ \(password text\) "PIN"/.exec(ft) || [])[1]);
      r = await w({ wait_for: { until: "value_contains", element_index: notesN, value: "draft", timeout_ms: 1000 } });
      check("value_contains on a plain field: met", !r.isError && /met after/.test(textOf(r)), true);
      r = await w({ wait_for: { until: "value_contains", element_index: pinN, value: "", timeout_ms: 1000 } });
      check("value_contains needs a value", r.isError === true && /value/.test(textOf(r)), true);
      r = await w({ wait_for: { until: "value_contains", element_index: pinN, value: "1234", timeout_ms: 1000 } });
      check("value_contains on a redacted field: never met, never revealed", !r.isError && /timed out/.test(textOf(r)) && /hidden/.test(textOf(r)) && !textOf(r).includes("1234"), true);
      for (const [label, wf, re] of [
        ["unknown until", { until: "sideways" }, /until/],
        ["appears without role, title_contains or element_index", { until: "appears" }, /role or title_contains/],
        ["checked without element_index", { until: "checked" }, /element_index/],
        ["not an object", "soon", /wait_for/],
      ]) {
        resetLog();
        r = await w({ wait_for: wf });
        check(`wait_for refused: ${label} (nothing spawned)`, r.isError === true && re.test(textOf(r)) && calls().length === 0, true);
      }
      // Stops between polls.
      useFix(fixFile4);
      let ab = false;
      hooks.fn = () => (ab = true);
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } }, { aborted: () => ab });
      check("regular: turn aborted mid-wait ends it (one poll)", r.isError === true && /aborted \(user interrupt\)/.test(textOf(r)) && finds().length === 1, true);
      let mine = true;
      hooks.fn = () => (mine = false);
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } }, { lock: async () => mine });
      check("lock taken by another session (handler callback) ends it", r.isError === true && /Another Claude session/.test(textOf(r)) && finds().length === 1, true);
      hooks.fn = () => wc.__linuxExecutor.__setLockHeld(true, "session_other");
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } });
      check("lock acquired by another holder (executor hook) ends it", r.isError === true && /Another Claude session/.test(textOf(r)) && finds().length === 1, true);
      hooks.fn = () => wc.__linuxExecutor.__setLockHeld(true, "session_w1");
      let n0 = 0;
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 1200 } });
      check("lock acquired by this session: the wait goes on", !r.isError && /timed out/.test(textOf(r)) && finds().length >= 2, true);
      hooks.fn = (n) => {
        if (n === 1) wc.__linuxExecutor.__cuTaskBoundary(null, "stop_click", null);
      };
      wc.__sleeps.length = 0;
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } });
      for (let i = 0; i < 100 && !calls().some((c) => c.argv[0] === "ax-restore"); i++) await tick();
      check("restore between polls ends the wait", r.isError === true && /ended/.test(textOf(r)), true);
      check("restore ran between the polls (no find after it)", calls().map((c) => c.argv[0]).filter((x) => x !== "windows").join(","), "ax-find,ax-restore");
      hooks.fn = () => (wc.__linuxExecutor.__stoppedByUser = () => true);
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } });
      check("stop sharing ends a wait", r.isError === true && /stopped screen sharing/.test(textOf(r)) && finds().length === 1, true);
      wc.__linuxExecutor.__stoppedByUser = () => false;
      hooks.fn = null;
      // Each poll is its own queue item: a call made during the wait runs
      // between two polls, not after the whole wait.
      let side = null;
      hooks.fn = (n) => {
        if (n === 1 && !side) side = wc.__cdbAxCall("app_list_windows", { app: "org.kde.kate" }, { sid: "w1" }).then(() => calls().length);
      };
      wc.__sleeps.length = 0;
      resetLog();
      r = await w({ title_contains: "Done", wait_for: { until: "appears", timeout_ms: 1200 } });
      const sideAt = await side;
      check("another call runs between polls (queue split)", sideAt < calls().length, true);
      hooks.fn = null;
      await releaseAx(wc);
      // Legacy bridge: the same wait, no --deadline-ms.
      setFeatures(undefined);
      useFix(fixFile3);
      const lw = waitCtx("x11-bridge", {});
      resetLog();
      r = await lw.__cdbAxCall("app_ax_find", { app: "org.kde.kate", window_id: "{kate-2}", title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } }, { sid: "lw" });
      check("legacy bridge: wait works, no new flags", !r.isError && /met after/.test(textOf(r)) && finds().every((c) => !c.argv.includes("--deadline-ms")), true);
      await releaseAx(lw);
      useFix(fixFile);
    }
    // kwin mode: upstream's dispatcher, its context's isAborted.
    {
      setFeatures(undefined);
      useFix(fixFile4);
      kctx2.__cdbCuAxElements = () => true;
      let ab = false;
      const realST = kctx2.setTimeout;
      kctx2.setTimeout = (fn, ms) => (ms >= 400 && ms <= 800 ? ((ab = true), setTimeout(fn, 0)) : realST(fn, ms));
      const da = kexp[DKEY](serverCtx(kctx2.__linuxExecutor), "pixels", { ...sessionCtx("sess-W"), isAborted: () => ab });
      resetLog();
      r = await da("app_ax_find", { app: "org.kde.kate", window_id: "{kate-2}", title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } });
      check("kwin: upstream's context isAborted ends the wait", r.isError === true && /aborted \(user interrupt\)/.test(textOf(r)) && finds().length === 1, true);
      kctx2.setTimeout = realST;
      kctx2.__cdbCuAxElements = () => false;
      await kctx2.__linuxExecutor.__setLockHeld(false);
      for (let i = 0; i < 100 && existsSync(statePath); i++) await tick();
      useFix(fixFile);
    }
    // Regular mode: the handler passes its abort test and lock check.
    check("handler passes aborted + lock to the accessibility call", /aborted:__abortedNow/.test(readFileSync(HANDLER_JS, "utf8")) && /lock:async function/.test(readFileSync(HANDLER_JS, "utf8")), true);
    if (injected) {
      const [, sP, nP, iP, seP] = mQ;
      setFeatures(undefined);
      useFix(fixFile4);
      const hc = axCtx("x11-bridge");
      let ab = false;
      hc.setTimeout = (fn, ms) => (ms >= 400 && ms <= 800 ? ((ab = true), setTimeout(fn, 0)) : setTimeout(fn, ms));
      const h = vm.runInContext(`(async function(${sP},${nP},${iP},${seP}){${injected}return{content:[{type:"text",text:"UPSTREAM"}]}})`, hc);
      resetLog();
      r = await h({}, "app_ax_find", { app: "org.kde.kate", window_id: "{kate-2}", title_contains: "Done", wait_for: { until: "appears", timeout_ms: 5000 } }, { sessionId: "hw", isAborted: () => ab });
      check("regular (patched handler): session isAborted ends the wait", r.isError === true && /aborted \(user interrupt\)/.test(textOf(r)) && finds().length === 1, true);
      await releaseAx(hc);
      useFix(fixFile);
    }

    // ---------------------------------------------------------------- [11]
    // ax-shape: within (a container's subtree), depth, outline (containers
    // only), include_text (every node), indented output, nameless groups
    // collapsed, "more inside" hints, the 24 KB cap and redaction unchanged.
    console.log("\n[11] within / depth / outline / include_text");
    {
      const KON_WIN = { id: "{konsole-1}", title: "Konsole", ref: ":1.60/w", frame_class: "unknown" };
      const kon = (elements, extra = {}) => ({ app: { name: "konsole", pid: 4242 }, window: KON_WIN, coords: "window_only", scope: "sc-kon", matched_by: "pid", truncated: false, total_seen: 30, elements, ...extra });
      const na = { actions: [] };
      const FIX5 = {
        ...FIX2,
        "ax-find": {
          ...FIX2["ax-find"],
          "{konsole-1}": kon([vEl(2, "page tab list", "Tabs", "r-tabs", { depth: 2, ...na }), vEl(5, "push button", "Run", "r-run", { depth: 3, parent_index: 2 }), vEl(6, "panel", "Gone box", "r-gonebox", { depth: 2, ...na })]),
          "{konsole-1}|all": kon([vEl(2, "page tab list", "Tabs", "r-tabs", { depth: 2, ...na }), vEl(5, "push button", "Run", "r-run", { depth: 3, parent_index: 2 }), vEl(7, "label", "Status: idle", "r-status", { depth: 2, ...na }), vEl(8, "text", "Cmd", "r-cmd", { depth: 2, value: "ls -la", states: ["editable"] })]),
          "{konsole-1}|root:r-tabs": kon(
            [
              vEl(1, "filler", "", "r-f1", { depth: 1, unique: null, ...na }),
              vEl(2, "page tab", "Tab A", "r-ta", { depth: 2, parent_index: 1, unique: null }),
              vEl(3, "panel", "", "r-p2", { depth: 1, unique: null, ...na }),
              vEl(4, "push button", "Inner 1", "r-i1", { depth: 2, parent_index: 3, unique: null }),
              vEl(5, "push button", "Inner 2", "r-i2", { depth: 2, parent_index: 3, unique: null }),
              vEl(6, "password text", "Secret", "r-sec", { depth: 2, parent_index: 3, value_redacted: true, unique: null, states: ["editable"] }),
            ],
            { root_ref: "r-tabs", truncated: true, truncated_reason: "nodes" }
          ),
          "{konsole-1}|root:r-run": { unavailable: "out_of_scope", hint: "The ref is not inside this window." },
          "{konsole-1}|root:r-gonebox": { unavailable: "stale_element", hint: "The element is gone." },
          "{konsole-1}|skeleton": kon([
            vEl(1, "panel", "Main", "s-main", { depth: 1, child_count: 3, ...na }),
            vEl(2, "filler", "", "s-f", { depth: 2, parent_index: 1, child_count: 1, ...na }),
            vEl(3, "panel", "Side", "s-side", { depth: 3, parent_index: 2, child_count: 5, ...na }),
          ]),
        },
      };
      const fixFile5 = join(scratch, "fixture-shape.json");
      writeFileSync(fixFile5, JSON.stringify(FIX5));
      useFix(fixFile5);
      setFeatures(ALL_FEATURES);
      const sc = axCtx("x11-bridge");
      const f = (a, sid = "s1") => sc.__cdbAxCall("app_ax_find", { app: "org.kde.konsole", ...a }, { sid });
      r = await f({});
      check("plain find of the window", !r.isError && textOf(r).includes('[2] AXUnknown (page tab list) "Tabs"'), true);
      resetLog();
      r = await f({ within: 2 });
      const wt = textOf(r);
      check("within: --root-ref <its ref> --scope <window scope>", argvs().filter((x) => x.startsWith("ax-find")).join("|"), "ax-find --window {konsole-1} --window-ref :1.60/w --root-ref r-tabs --scope sc-kon");
      check("within: says it lists the inside of [2]", /inside \[2\]/.test(wt), true);
      check("within: a nameless group with one child is collapsed", !/\(filler\)/.test(wt), true);
      check("within: indented by depth (collapsed group lifts its child)", /\n\[\d+\] AXRadioButton \(page tab\) "Tab A"/.test(wt) && /\n {2}\[\d+\] AXButton \(push button\) "Inner 1"/.test(wt) && /\n\[\d+\] AXGroup \(panel\) ""/.test(wt), true);
      check("within: redaction as in a plain find", /"Secret" \(editable\) value hidden/.test(wt), true);
      check("within: a truncated walk says how to continue", /within/.test(wt.split("\n")[0]), true);
      check("within: [N] of the elements are allocated in the window's table", /\[(?!2\])\d+\] AXButton \(push button\) "Inner 1"/.test(wt), true);
      r = await f({ within: 5 });
      check("within an element outside the window's tree (bridge out_of_scope): refused", r.isError === true && /out_of_scope/.test(textOf(r)), true);
      r = await f({ within: 6 });
      check("within a container that is gone: refused, find again", r.isError === true && /gone/.test(textOf(r)) && /app_ax_find again/.test(textOf(r)), true);
      r = await f({ within: 99 });
      check("within an unknown [N]: refused", r.isError === true && textOf(r).includes("No element [99]"), true);
      await sc.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "s1" });
      const kateN = 26;
      r = await f({ within: kateN });
      check("within an [N] of another window (granted or not): refused", r.isError === true && textOf(r).includes(`No element [${kateN}]`), true);
      resetLog();
      r = await f({ outline: true, depth: 3 });
      const ot = textOf(r);
      check("outline + depth: --skeleton --max-depth 3", argvs().filter((x) => x.startsWith("ax-find")).join("|"), "ax-find --window {konsole-1} --window-ref :1.60/w --max-depth 3 --skeleton");
      check("outline: containers with their child count, indented", /\[\d+\] AXGroup \(panel\) "Main" .*3 children/.test(ot) && /\n {2}\[\d+\] AXGroup \(panel\) "Side"/.test(ot), true);
      check("outline: nameless single-child group collapsed", !/\(filler\)/.test(ot), true);
      check("outline: a container cut by depth says how to look inside", /5 more inside - pass within: \[\d+\]/.test(ot), true);
      r = await f({ outline: true, role: "push button" });
      check("outline with role: refused (outline lists containers only)", r.isError === true && /outline/.test(textOf(r)), true);
      resetLog();
      r = await f({ include_text: true });
      check("include_text: --all", argvs().filter((x) => x.startsWith("ax-find")).join("|"), "ax-find --window {konsole-1} --window-ref :1.60/w --all");
      check("include_text: labels listed, values as in a plain find", /"Status: idle"/.test(textOf(r)) && /value "ls -la"/.test(textOf(r)), true);
      resetLog();
      r = await f({ depth: 99 });
      check("depth clamped to 64", argvs().filter((x) => x.startsWith("ax-find")).join("|"), "ax-find --window {konsole-1} --window-ref :1.60/w --max-depth 64");
      await releaseAx(sc);
      // A bridge that lists none of these: a clear refusal, nothing walked.
      for (const [label, feats, arg, re] of [
        ["legacy: within", undefined, { within: 2 }, /within is not supported by this bridge/],
        ["legacy: outline", undefined, { outline: true }, /outline is not supported by this bridge/],
        ["legacy: depth", undefined, { depth: 2 }, /depth is not supported by this bridge/],
        ["legacy: include_text", undefined, { include_text: true }, /include_text is not supported by this bridge/],
        ["no find.root: within", ALL_FEATURES.filter((x) => x !== "find.root"), { within: 2 }, /within is not supported by this bridge/],
        ["no find.skeleton: outline", ALL_FEATURES.filter((x) => x !== "find.skeleton"), { outline: true }, /outline is not supported by this bridge/],
      ]) {
        setFeatures(feats);
        const c = axCtx("x11-bridge");
        resetLog();
        r = await c.__cdbAxCall("app_ax_find", { app: "org.kde.konsole", ...arg }, { sid: "s2" });
        check(`${label}: refused, nothing walked`, r.isError === true && re.test(textOf(r)) && !calls().some((x) => x.argv[0] === "ax-find"), true);
        await releaseAx(c);
      }
      setFeatures(undefined);
      useFix(fixFile);
    }

    // ---------------------------------------------------------------- [12]
    // ax-actions: ensure on app_click, app_focus, app_scroll (into view), a
    // number through app_type on a Value control; the tool list per bridge.
    console.log("\n[12] ensure / app_focus / app_scroll / set-value; tool lists");
    {
      const V6 = [
        ...V_A,
        vEl(30, "slider", "Volume", "r-vol", { actions: [], value: "40" }),
        vEl(31, "slider", "Balance", "r-vol2", { actions: [], value: "0" }),
        vEl(32, "spin button", "Size", "r-size", { states: ["enabled", "editable"], value: "12" }),
      ];
      const FIX6 = {
        ...FIX2,
        "ax-find": { ...FIX2["ax-find"], "{kate-1}": kateFind(V6) },
        "ax-action": {
          ...FIX2["ax-action"],
          "r-wrap|ensure-checked": { ok: true, action: "ensure_checked", method: "action:toggle", already: false, delivery: "sent", post: { focused: false, checked: true } },
          "r-wrap|ensure-unchecked": { ok: true, action: "ensure_unchecked", method: "none", already: true, delivery: "not_sent", post: { focused: false, checked: false } },
          "ok-2|ensure-expanded": { unavailable: "unsupported_action", hint: "This element cannot be expanded.", delivery: "not_sent" },
          "noact-1|ensure-collapsed": { unavailable: "requires_input", hint: "Qt combo popup on Wayland.", delivery: "not_sent" },
          "nope-1|ensure-selected": { ok: null, action: "ensure_selected", method: "select_child", already: false, delivery: "sent_unverified", error: "read-back shows selected=false" },
          "r-search|focus": { ok: true, action: "focus", method: "grab_focus", delivery: "sent", post: { focused: true } },
          "r-save|scroll-to": { ok: true, action: "scroll_to", method: "scroll_to", delivery: "sent", post: { focused: false } },
          "noact-1|scroll-to": { unavailable: "unsupported_action", hint: "No Component interface.", delivery: "not_sent" },
          "r-vol|set-value": { ok: true, action: "set_value", method: "set_current_value", delivery: "sent", post: { focused: false, value: "75" } },
          "r-vol2|set-value": { unavailable: "value_out_of_range", hint: "Out of range.", range: { min: -10, max: 10 }, delivery: "not_sent" },
          "r-size|set-value": { ok: true, action: "set_value", method: "set_current_value", delivery: "sent", post: { focused: true, value: "14" } },
        },
      };
      const fixFile6 = join(scratch, "fixture-actions.json");
      writeFileSync(fixFile6, JSON.stringify(FIX6));
      useFix(fixFile6);
      setFeatures(ALL_FEATURES);
      const ac = axCtx("x11-bridge");
      ac.__cuLastShot = { imgW: 1000, imgH: 1000, dispW: 1000, dispH: 1000, originX: 0, originY: 0 };
      const x = (n, a, sid = "a1") => ac.__cdbAxCall(n, { app: "org.kde.kate", ...a }, { sid });
      await x("app_ax_find", {});
      resetLog();
      r = await x("app_click", { element_index: 12, ensure: "checked" });
      check("ensure checked: --action ensure-checked with the identity on stdin", acts().map((c) => c.argv.slice(5).join(" ")).join() + "|" + acts()[0]?.stdin, "--action ensure-checked --expect-json|" + JSON.stringify({ expect: { role: "check box", name: "Word wrap", accessible_id: null } }));
      check("ensure checked: done and verified, now checked", !r.isError && /\[12\]/.test(textOf(r)) && /now checked/.test(textOf(r)), true);
      r = await x("app_click", { element_index: 12, ensure: "unchecked" });
      check("ensure already in that state: says nothing was sent", !r.isError && /already unchecked/.test(textOf(r)) && /nothing was sent/i.test(textOf(r)), true);
      r = await x("app_click", { element_index: 14, ensure: "expanded" });
      check("ensure unsupported_action: nothing sent, points to app_click / left_click", r.isError === true && /unsupported_action/.test(textOf(r)) && /nothing was sent/i.test(textOf(r)) && /left_click/.test(textOf(r)), true);
      r = await x("app_click", { element_index: 26, ensure: "collapsed" });
      check("ensure requires_input: nothing sent, left_click at its center", r.isError === true && /requires_input/.test(textOf(r)) && /left_click/.test(textOf(r)) && /at \(/.test(textOf(r)), true);
      r = await x("app_click", { element_index: 25, ensure: "selected" });
      check("ensure ok:null (read-back did not confirm): never worded as success", !/^Set |^Pressed /.test(textOf(r)) && /not confirmed/.test(textOf(r)) && /do not repeat it blindly/i.test(textOf(r)), true);
      resetLog();
      r = await x("app_click", { element_index: 12, ensure: "sideways" });
      check("ensure: unknown state refused, nothing spawned", r.isError === true && /ensure must be one of/.test(textOf(r)) && acts().length === 0, true);
      resetLog();
      r = await x("app_focus", { element_index: 5 });
      check("app_focus: --action focus, focused", acts().map((c) => c.argv.slice(5).join(" ")).join() + "|" + /^Focused \[5\]/.test(textOf(r)) + "|" + /now focused/.test(textOf(r)), "--action focus --expect-json|true|true");
      resetLog();
      r = await x("app_scroll", { element_index: 3 });
      check("app_scroll: --action scroll-to, scrolled into view", acts().map((c) => c.argv.slice(5).join(" ")).join() + "|" + /^Scrolled \[3\] .* into view/.test(textOf(r)), "--action scroll-to --expect-json|true");
      resetLog();
      for (const bad of [{ coordinate: [10, 10] }, { scroll_direction: "down" }, { dx: 0, dy: 3 }]) {
        r = await x("app_scroll", { element_index: 3, ...bad });
        check(`app_scroll ${Object.keys(bad)[0]}: refused with a pointer to scroll, nothing spawned`, r.isError === true && /\bscroll\b.*coordinate/.test(textOf(r)) && calls().length === 0, true);
      }
      r = await x("app_scroll", { element_index: 26 });
      check("app_scroll unsupported_action: nothing sent, scroll at a point instead", r.isError === true && /unsupported_action/.test(textOf(r)) && /nothing was sent/i.test(textOf(r)) && /scroll/.test(textOf(r)), true);
      resetLog();
      r = await x("app_type", { element_index: 30, text: " 75 " });
      check("app_type number on a slider: set-value, the number in the JSON", acts().map((c) => c.argv.slice(5).join(" ")).join() + "|" + acts()[0]?.stdin, "--action set-value --expect-json|" + JSON.stringify({ expect: { role: "slider", name: "Volume", accessible_id: null }, value: 75 }));
      check("set-value: done, value shown", !r.isError && /\[30\]/.test(textOf(r)) && /value now 75/.test(textOf(r)), true);
      r = await x("app_type", { element_index: 31, text: "50" });
      check("value_out_of_range: nothing sent, names the range", r.isError === true && /-10 to 10/.test(textOf(r)) && /nothing was sent/i.test(textOf(r)), true);
      resetLog();
      r = await x("app_type", { element_index: 30, text: "loud" });
      check("app_type text on a slider: refused, nothing spawned", r.isError === true && /number/.test(textOf(r)) && acts().length === 0, true);
      resetLog();
      r = await x("app_type", { element_index: 32, text: "14" });
      check("app_type number on a spin button: set-value (no overwrite_existing needed)", acts().map((c) => c.argv[6]).join() + "|" + !r.isError, "set-value|true");
      ac.__linuxExecutor.__stoppedByUser = () => true;
      resetLog();
      for (const [n, a] of [["app_click", { element_index: 12, ensure: "checked" }], ["app_focus", { element_index: 5 }], ["app_scroll", { element_index: 3 }], ["app_type", { element_index: 30, text: "5" }]]) {
        r = await x(n, a);
        check(`stopped sharing: ${n}${a.ensure ? " ensure" : ""} refused`, r.isError === true && /stopped screen sharing/.test(textOf(r)), true);
      }
      check("stopped sharing: no ax-action spawned", acts().length, 0);
      ac.__linuxExecutor.__stoppedByUser = () => false;
      check("v2 bridge: app_focus / app_scroll handled", ac.__cdbAxHandles("app_focus") && ac.__cdbAxHandles("app_scroll"), true);
      // Tool list with a v2 bridge.
      const v2tools = ac.__cdbAxTools({ platform: "linux" });
      const pr = (n) => Object.keys(v2tools.find((t) => t.name === n)?.inputSchema?.properties || {}).join(",");
      check("v2 tools: six, upstream's names", v2tools.map((t) => t.name).join(), "app_list_windows,app_ax_find,app_click,app_type,app_focus,app_scroll");
      check("v2 app_ax_find args", pr("app_ax_find"), "app,window_id,role,title_contains,wait_for,within,depth,outline,include_text");
      check("v2 app_click args", pr("app_click"), "app,window_id,element_index,target,ensure");
      check("v2 app_focus args", pr("app_focus"), "app,window_id,element_index,target");
      check("v2 app_scroll args + required", pr("app_scroll") + "|" + v2tools.find((t) => t.name === "app_scroll").inputSchema.required.join(), "app,window_id,element_index|app,element_index");
      check("v2 tools: no coordinate arguments", v2tools.some((t) => /coordinate|region|path/.test(Object.keys(t.inputSchema.properties).join())), false);
      const v2bytes = v2tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.inputSchema).length, 0);
      check("v2 tools: schema + descriptions within ~7 KB", v2bytes <= 7000, true);
      await releaseAx(ac);
      // Feature by feature: an unlisted feature is neither offered nor used.
      setFeatures(["find.v1", "action.click", "action.set_text", "find.identity", "action.expect"]);
      const pc = axCtx("x11-bridge");
      const ptools = pc.__cdbAxTools({ platform: "linux" });
      check("partial features: four tools, no ensure / within / outline", ptools.map((t) => t.name).join() + "|" + Object.keys(ptools[2].inputSchema.properties).join() + "|" + Object.keys(ptools[1].inputSchema.properties).join(), "app_list_windows,app_ax_find,app_click,app_type|app,window_id,element_index,target|app,window_id,role,title_contains,wait_for,depth,include_text");
      check("partial features: app_focus / app_scroll not handled", pc.__cdbAxHandles("app_focus") || pc.__cdbAxHandles("app_scroll"), false);
      await pc.__cdbAxCall("app_ax_find", { app: "org.kde.kate" }, { sid: "p1" });
      resetLog();
      r = await pc.__cdbAxCall("app_click", { app: "org.kde.kate", element_index: 12, ensure: "checked" }, { sid: "p1" });
      check("partial features: ensure refused as not supported, nothing sent", r.isError === true && /ensure is not supported by this bridge/.test(textOf(r)) && acts().length === 0, true);
      r = await pc.__cdbAxCall("app_type", { app: "org.kde.kate", element_index: 30, text: "5" }, { sid: "p1" });
      check("partial features: a number on a slider is not set-value (today's refusal)", r.isError === true && /Only target TEXT fields/.test(textOf(r)), true);
      await releaseAx(pc);
      // Legacy bridge: today's four tools, byte-identical to the list without a bridge.
      setFeatures(undefined);
      const lc = axCtx("x11-bridge");
      check("legacy bridge: tool list identical to the four-tool list", JSON.stringify(lc.__cdbAxTools({ platform: "linux" })), JSON.stringify(axTools));
      check("legacy bridge: key :cdb-ax2", lc.__cdbAxKey(), ":cdb-ax2");
      check("legacy bridge: app_focus / app_scroll not handled (go where they went before)", lc.__cdbAxHandles("app_focus") || lc.__cdbAxHandles("app_scroll"), false);
      check("legacy bridge: the four still handled", ["app_list_windows", "app_ax_find", "app_click", "app_type"].every((n) => lc.__cdbAxHandles(n)), true);
      useFix(fixFile);
    }
    // Upstream's own app-tool predicate and tier map (pristine bundle): our
    // two new names pass upstream's check, and each of our tools asks for the
    // tier upstream's map gives it (15d calls the tier check with TIER[name]).
    {
      const all = [...pristine.values()].join("\n");
      const qm = /function ([\w$]+)\(([\w$]+)\)\{return \2===(["`])app_release\3\|\|\2===\3request_full_control\3\|\|\2===\3release_full_control\3\|\|Object\.hasOwn\(([\w$]+),\2\)\}/.exec(all);
      const mapM = qm && new RegExp(`(?<![\\w$.])${qm[4].replace(/\$/g, "\\$")}=(\\{app_[^{}]*\\})`).exec(all);
      check("upstream's app-tool predicate and tier map located in the pristine bundle", !!qm && !!mapM, true);
      if (qm && mapM) {
        const up = vm.runInNewContext(`(function(){var ${qm[4]}=${mapM[1]};${qm[0]};return{is:${qm[1]},tiers:${qm[4]}}})()`);
        check("upstream predicate: app_focus and app_scroll are app tools", up.is("app_focus") && up.is("app_scroll"), true);
        const tc = axCtx("x11-bridge");
        const asked = {};
        for (const n of ["app_list_windows", "app_ax_find", "app_click", "app_type", "app_focus", "app_scroll"]) {
          await tc.__cdbAxCall(n, { app: "org.kde.kate" }, { sid: "t1", tier: (_a, t) => ((asked[n] = t), { error: { isError: true, content: [{ type: "text", text: "stop" }] } }) });
        }
        check("our tier per tool = upstream's tier map", JSON.stringify(asked), JSON.stringify(Object.fromEntries(Object.keys(asked).map((n) => [n, up.tiers[n]]))));
        check("every one of our tools passes upstream's predicate", Object.keys(asked).every((n) => up.is(n)), true);
      }
    }
    // kwin mode end to end: upstream's dispatcher reaches our app_focus /
    // app_scroll through its own app-tool branch and tier check.
    {
      setFeatures(ALL_FEATURES);
      writeFileSync(join(scratch, "fixture-kwin6.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(scratch, "fixture-actions.json"), "utf8")) }));
      useFix(join(scratch, "fixture-kwin6.json"));
      const kc6 = makeCtx({ userData });
      kc6.__cuKwinMode = true;
      kc6.__cuKwinBridgeBin = bin;
      kc6.__linuxExecutor = kwinExecutor();
      const kx6 = loadChunk(kc6, patched.get(builderChunk));
      loadAx(kc6);
      kc6.__cdbCuAxElements = () => true;
      const dk = kx6[DKEY](serverCtx(kc6.__linuxExecutor), "pixels", sessionCtx("sess-K6"));
      dims = { width: 1280, height: 720, displayWidth: 2560, displayHeight: 1440, originX: 0, originY: 0 };
      const ktools = kx6[BKEY](LINUX_CAPS, "pixels").map((t) => t.name);
      check("kwin, v2 bridge: upstream's builder lists app_focus and app_scroll", ktools.includes("app_focus") && ktools.includes("app_scroll"), true);
      await dk("app_ax_find", { app: "org.kde.kate" });
      resetLog();
      r = await dk("app_focus", { app: "org.kde.kate", element_index: 5 });
      check("kwin: app_focus through upstream's dispatch", /^Focused \[5\]/.test(textOf(r)) && acts().length === 1, true);
      r = await dk("app_scroll", { app: "org.kde.kate", element_index: 3 });
      check("kwin: app_scroll through upstream's dispatch", /^Scrolled \[3\]/.test(textOf(r)), true);
      resetLog();
      r = await dk("app_scroll", { app: "org.kde.dolphin", element_index: 2 });
      check("kwin: app_scroll needs tier click (upstream's check)", r.isError === true && textOf(r).includes('requires tier "click"') && calls().length === 0, true);
      r = await dk("app_focus", { app: "org.kde.konsole", element_index: 1 });
      check("kwin: app_focus needs tier full (upstream's check)", r.isError === true && textOf(r).includes('requires tier "full"') && calls().length === 0, true);
      await kc6.__linuxExecutor.__setLockHeld(false);
      for (let i = 0; i < 100 && existsSync(statePath); i++) await tick();
      kc6.__cdbCuAxElements = () => false;
      setFeatures(undefined);
      useFix(fixFile);
    }

    // ---------------------------------------------------------------- [13]
    // Re-identification never retargets to a twin; numbers never come back
    // for another control; numbers are bound to the app they were listed for.
    console.log("\n[13] re-identification, numbering, app binding");
    const HIDDEN = ["enabled", "sensitive"];
    const xWin = (id, title, cls, extra = {}) => ({ id, title, resource_class: cls, stacking_order: 1, geometry: { x: 0, y: 0, width: 800, height: 600 }, ...extra });
    const xFind = (id, elements, extra = {}) => ({ app: { name: id }, window: { id, title: id, ref: ":1.300/" + id }, coords: "window_only", scope: "sc-" + id, matched_by: "app_id", truncated: false, total_seen: 20, elements, ...extra });
    const FIX13 = {
      ...FIX2,
      windows: [
        ...FIXTURE.windows,
        xWin("{ri-1}", "Reid", "org.example.reid"),
        xWin("{nm-1}", "Num 1", "org.example.num"),
        xWin("{nm-2}", "Num 2", "org.example.num"),
        xWin("{nm-3}", "Num 3", "org.example.num"),
      ],
      "ax-find": {
        ...FIX2["ax-find"],
        "{ri-1}": xFind("{ri-1}", [
          vEl(3, "push button", "Apply", "a-1", { accessible_id: "a-clip" }),
          vEl(4, "push button", "Rename", "b-1", { accessible_id: "b-id" }),
          vEl(5, "push button", "Lone", "c-1", { accessible_id: "c-id" }),
          vEl(6, "push button", "Hidden", "d-1", { accessible_id: "d-id" }),
          vEl(7, "push button", "Fine", "e-1", { accessible_id: "e-id" }),
          vEl(8, "push button", "Plain", "f-1"),
        ]),
        "{ri-1}|all": xFind("{ri-1}", [
          vEl(3, "push button", "Apply", "a-2", { accessible_id: "a-clip", unique: false }),
          vEl(30, "push button", "Apply", "a-3", { accessible_id: "a-clip", unique: false, states: HIDDEN }),
          vEl(4, "push button", "Rename it", "b-2", { accessible_id: "b-id" }),
          vEl(5, "push button", "Lone", "c-2", { accessible_id: "c-id", unique: false }),
          vEl(6, "push button", "Hidden", "d-2", { accessible_id: "d-id", states: HIDDEN }),
          vEl(7, "push button", "Fine", "e-2", { accessible_id: "e-id" }),
          vEl(8, "push button", "Plain", "f-2", { unique: false }),
        ]),
        "{nm-1}": xFind("{nm-1}", [vEl(3, "push button", "Alpha", "n-a"), vEl(4, "push button", "Beta", "n-b")]),
        "{nm-1}|all": xFind("{nm-1}", [vEl(3, "push button", "Gamma", "n-g"), vEl(4, "text", "Field", "n-f", { states: ["enabled", "showing", "editable", "focused"] })]),
        "{nm-2}": { __seq: [xFind("{nm-2}", [vEl(3, "push button", "Old", "p-old")], { app: { name: "num", pid: 100 } }), xFind("{nm-2}", [vEl(3, "push button", "New", "p-new")], { app: { name: "num", pid: 200 } })] },
        "{nm-3}": { __seq: [xFind("{nm-3}", [vEl(3, "push button", "Old", "w-old")]), xFind("{nm-3}", [vEl(3, "push button", "New", "w-new")], { window: { id: "{nm-3}", title: "Num 3", ref: ":1.300/other-window" } })] },
      },
      "ax-find-app": {
        ...FIX2["ax-find-app"],
        "org.example.Notes|notes.txt": { app: { name: "notes" }, window: { title: "notes.txt", ref: ":1.82/w", frame_class: "unknown" }, coords: "window_only", scope: "sc-notes", matched_by: "app_id", truncated: false, total_seen: 5, elements: [vEl(4, "push button", "Delete all", "notes-del")] },
      },
      "ax-action": {
        ...FIX2["ax-action"],
        ...Object.fromEntries(["a-1", "b-1", "c-1", "d-1", "e-1", "f-1"].map((k) => [k, ST("not_sent")])),
        "e-2": OKA("click"),
        "n-a": OKA("click"),
        "n-g": OKA("click"),
        "n-f": OKA("click"),
        "p-new": OKA("click"),
        "w-new": OKA("click"),
        "notes-del": OKA("click"),
        "te-open": OKA("click"),
        "wa-1": OKA("click"),
        "wb-1": OKA("click"),
      },
    };
    const fixFile13 = join(scratch, "fixture-review.json");
    writeFileSync(fixFile13, JSON.stringify(FIX13));
    {
      useFix(fixFile13);
      setFeatures(ALL_FEATURES);
      const rc = axCtx("x11-bridge");
      const q = (n, a, sid = "r1") => rc.__cdbAxCall(n, a, { sid });
      const reidApp = "org.example.reid";
      await q("app_ax_find", { app: reidApp });
      resetLog();
      r = await q("app_click", { app: reidApp, element_index: 3 });
      check("re-find walks hidden nodes too (--include-hidden)", finds().length === 1 && finds()[0].argv.includes("--include-hidden"), true);
      check("id twin that is clipped (not showing): ambiguous, nothing re-sent", r.isError === true && /ambiguous/i.test(textOf(r)) && /nothing was sent/i.test(textOf(r)) && acts().length === 1, true);
      resetLog();
      r = await q("app_click", { app: reidApp, element_index: 4 });
      check("id match with another name: not the same control, gone, nothing re-sent", r.isError === true && /gone/.test(textOf(r)) && acts().length === 1, true);
      resetLog();
      r = await q("app_click", { app: reidApp, element_index: 5 });
      check("lone id match that reports unique:false: ambiguous, nothing re-sent", r.isError === true && /ambiguous/i.test(textOf(r)) && acts().length === 1, true);
      resetLog();
      r = await q("app_click", { app: reidApp, element_index: 6 });
      check("lone match that is not showing: gone, nothing re-sent", r.isError === true && /gone/.test(textOf(r)) && acts().length === 1, true);
      resetLog();
      r = await q("app_click", { app: reidApp, element_index: 8 });
      check("lone role + name match that reports unique:false: ambiguous", r.isError === true && /ambiguous/i.test(textOf(r)) && acts().length === 1, true);
      resetLog();
      r = await q("app_click", { app: reidApp, element_index: 7 });
      check("id + name + showing + unique: re-identified and pressed", !r.isError && /re-identified/.test(textOf(r)) && acts().map((c) => c.argv[4]).join() === "e-1,e-2", true);

      // Numbers never come back for another control.
      const numApp = "org.example.num";
      await q("app_ax_find", { app: numApp, window_id: "{nm-1}" });
      await rc.__linuxExecutor.__setLockHeld(false);
      resetLog();
      r = await q("app_click", { app: numApp, window_id: "{nm-1}", target: "focused" });
      const fN = Number((/^Pressed \[(\d+)\]/.exec(textOf(r)) || [])[1]);
      check("target focused after a lock release: a number above every earlier one", fN > 4, true);
      resetLog();
      r = await q("app_click", { app: numApp, window_id: "{nm-1}", element_index: 3 });
      check("an old [N] after the window was listed again (focused walk): unknown, nothing sent", r.isError === true && /No element \[3\]/.test(textOf(r)) && /list the window again|app_ax_find again/.test(textOf(r)) && acts().length === 0, true);
      await q("app_ax_find", { app: numApp, window_id: "{nm-2}" });
      r = await q("app_ax_find", { app: numApp, window_id: "{nm-2}" });
      check("pid change: the new process's controls get new numbers", /\[3\] AXButton \(push button\) "New"/.test(textOf(r)), false);
      resetLog();
      r = await q("app_click", { app: numApp, window_id: "{nm-2}", element_index: 3 });
      check("pid change: the old [3] is unknown, nothing sent", r.isError === true && /No element \[3\]/.test(textOf(r)) && acts().length === 0, true);
      await q("app_ax_find", { app: numApp, window_id: "{nm-3}" });
      r = await q("app_ax_find", { app: numApp, window_id: "{nm-3}" });
      check("new window ref: the new window's controls get new numbers", /\[3\] AXButton \(push button\) "New"/.test(textOf(r)), false);
      resetLog();
      r = await q("app_click", { app: numApp, window_id: "{nm-3}", element_index: 3 });
      check("new window ref: the old [3] is unknown, nothing sent", r.isError === true && /No element \[3\]/.test(textOf(r)) && acts().length === 0, true);
      const desc = rc.__cdbAxTools({ platform: "linux" }).find((t) => t.name === "app_ax_find").description;
      check("app_ax_find text: numbers last until the app or window is re-created or the task ends", /stays the same/.test(desc) && /re-created/.test(desc) && /task ends/.test(desc) && /unknown number/.test(desc), true);
      await releaseAx(rc);
    }
    // App binding: GNOME names windows by title, so two apps can share a
    // window id; wlroots window ids shift between apps.
    {
      useFix(fixFile13);
      setFeatures(ALL_FEATURES);
      const gc = makeCtx({ userData });
      gc.__linuxExecutor = { capabilities: { platform: "linux" }, __axBridge: () => ({ bin, name: "gnome-portal-bridge" }), async __setLockHeld() {}, async __cuTaskBoundary() {} };
      gc.__cdbCuAxElements = () => true;
      loadAx(gc);
      const tier = (id, t) => (id === "org.example.Notes" && t !== "read" ? { error: { isError: true, content: [{ type: "text", text: 'TIER: "' + id + '" needs ' + t }] } } : null);
      const g = (n, a) => gc.__cdbAxCall(n, a, { sid: "gb", tier });
      r = await g("app_ax_find", { app: "org.gnome.TextEditor", window_id: "notes.txt" });
      check("GNOME: app A's window notes.txt listed", !r.isError && /\[4\] AXButton \(push button\) "Open"/.test(textOf(r)), true);
      resetLog();
      r = await g("app_click", { app: "org.example.Notes", window_id: "notes.txt", element_index: 4 });
      check("GNOME: B's call is held to B's tier (click refused for a read grant)", r.isError === true && /TIER/.test(textOf(r)) && acts().length === 0, true);
      r = await g("app_ax_find", { app: "org.example.Notes", window_id: "notes.txt" });
      check("GNOME: app B's window with the same title listed (read)", !r.isError && /"Delete all"/.test(textOf(r)), true);
      const tierB = () => null;
      resetLog();
      r = await gc.__cdbAxCall("app_click", { app: "org.example.Notes", window_id: "notes.txt", element_index: 4 }, { sid: "gb", tier: tierB });
      check("GNOME: B's [4] is B's own element, never A's", acts().map((c) => c.argv[4]).join(), "notes-del");
      r = await g("app_ax_find", { app: "org.gnome.TextEditor", window_id: "notes.txt" });
      await gc.__linuxExecutor.__setLockHeld(false);
      await g("app_ax_find", { app: "org.example.Notes", window_id: "notes.txt" });
      resetLog();
      r = await gc.__cdbAxCall("app_click", { app: "org.gnome.TextEditor", window_id: "notes.txt", element_index: 4 }, { sid: "gb", tier: tierB });
      check("GNOME: a number learned through B is not usable through A (same title)", r.isError === true && /No element \[4\]/.test(textOf(r)) && acts().length === 0, true);
      r = await g("app_ax_find", { app: "org.gnome.TextEditor", window_id: "notes.txt" });
      resetLog();
      r = await g("app_click", { app: "org.example.Notes", window_id: "notes.txt", element_index: 4 });
      check("GNOME: B's tier still applies to B after A listed the title again", r.isError === true && /TIER/.test(textOf(r)) && acts().length === 0, true);
      await releaseAx(gc);
    }
    {
      const wa = { id: "{wl-9}", title: "Alpha", desktop_file_name: "org.example.alpha", stacking_order: 1, geometry: { x: 0, y: 0, width: 800, height: 600 } };
      const wb = { ...wa, title: "Beta", desktop_file_name: "org.example.beta" };
      const FIXW = {
        ...FIX13,
        windows: { __seq: [[wa], [wb]] },
        "ax-find": {
          ...FIX13["ax-find"],
          "{wl-9}": { __seq: [xFind("{wl-9}", [vEl(3, "push button", "Alpha thing", "wa-1")]), xFind("{wl-9}", [vEl(3, "push button", "Beta thing", "wb-1")])] },
        },
      };
      const fixW = join(scratch, "fixture-review-wl.json");
      writeFileSync(fixW, JSON.stringify(FIXW));
      useFix(fixW);
      setFeatures(ALL_FEATURES);
      const wc2 = makeCtx({ userData });
      wc2.__linuxExecutor = { capabilities: { platform: "linux" }, __axBridge: () => ({ bin, name: "wlroots-bridge" }), async __setLockHeld() {}, async __cuTaskBoundary() {} };
      wc2.__cdbCuAxElements = () => true;
      loadAx(wc2);
      r = await wc2.__cdbAxCall("app_ax_find", { app: "org.example.alpha", window_id: "{wl-9}" }, { sid: "wb" });
      check("wlroots: app A's window {wl-9} listed", !r.isError && /\[3\] AXButton \(push button\) "Alpha thing"/.test(textOf(r)), true);
      resetLog();
      r = await wc2.__cdbAxCall("app_click", { app: "org.example.beta", window_id: "{wl-9}", element_index: 3 }, { sid: "wb" });
      check("wlroots: the id now names app B's window: A's [3] is not usable through B", r.isError === true && /No element \[3\]/.test(textOf(r)) && acts().length === 0, true);
      await releaseAx(wc2);
    }
    setFeatures(undefined);
    useFix(fixFile);

    // Every legacy-bridge call in every section above stayed within today's
    // flags, actions and stdin shapes.
    const violations = existsSync(logFile + ".legacy-violations") ? readFileSync(logFile + ".legacy-violations", "utf8").trim() : "";
    check("legacy bridge: no new flag, action or stdin shape was ever sent", violations, "");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  console.log(`(${pass} passed)`);
  process.exit(1);
}
if (skipped) {
  console.log(`${pass} checks passed; real-bundle sections SKIPPED`);
  process.exit(SKIP_EXIT);
}
console.log("ALL " + pass + " CHECKS PASSED");
