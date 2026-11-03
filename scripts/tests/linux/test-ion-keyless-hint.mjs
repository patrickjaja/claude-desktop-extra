#!/usr/bin/env node
// Cowork header: a device icon that explains why a KEYLESS desktop has no
// Computer Use.
//
// WHY THIS EXISTS
// ---------------
// A Linux user who cannot open /dev/tpmrm0 registers this desktop with
// Anthropic's servers as a KEYLESS device. The server refuses to bind cloud
// Cowork / Dispatch sessions to it (keyless_admission_refused, the SPA retries
// without a bind target), so the session's binding state is "unbound" and
// upstream's header seat renders nothing at all: no device icon, no popover,
// no hint why Computer Use is missing. Sub-patch C of
// patches/linux/fix_ion_dist_linux.nim (4.4212.0 names) makes the seat's
// unbound branch
//   if(!Cj(o))return null;  ->  if(!Cj(o))return __cdbKeylessSeat(o,a);
// wraps the popover's status-line builder call inside Nj
//   {title:d,statusLine:f,iconLabel:p}=Mj(n)
//   -> {title:d,statusLine:f,iconLabel:p}=__cdbKeylessLine(Mj(n),n)
// and inserts the helpers before Cj. On Linux and binding state exactly
// "unbound", a small component subscribes (the chunk's useSyncExternalStore) to
// upstream's deviceLinkStore (globalThis["claude.web"].WindowState) and, while
// it reports connected + idSource "keyless", renders upstream's own popover Nj
// with a warning dot and the Computer Use status hint.
//
// The binding states come from the REAL producer, the lu hook (shared-29 cO in
// 4.4212.0): "inapplicable" (remote device link off, or not a remote session),
// "unknown" (no binding data yet), "unbound" (the server says no bound device),
// "bound" (any bound device id, this desktop or another one). [C] asserts that
// producer's literal set against the real SPA.
//
// This harness pins:
//   [A] the compiled patch on a fixture of the verbatim 4.4212.0 functions
//       (Cj, the header seat wj, Ej, Dj, kj, Aj, jj, Mj, Nj, Pj, Fj): applies
//       with the full counter, only our three splices differ, node --check,
//       idempotent (byte-identical second run), and Rule 6 refusals
//   [B] behavior: the REAL seat -> Nj -> Fj -> Pj render path of the fixture,
//       pristine vs patched, with stubbed hooks fed the traced binding states.
//       Every non-hint case must render a tree identical to pristine upstream.
//   [C] the same against the real SPA (resources/ion-dist.asar under
//       tmp/extract, SKIPPED when there is none; CDB_ION_TREE points at another
//       install tree): pristine anchors, the lu producer's states, one apply
//       over every assets/v1 file, exactly three files changed, the C file
//       differs only by our three splices, node --check, idempotent, and [B]'s
//       table over the REAL pristine and patched chunk.
//
// CDB_ION_PATCH_BIN points at another compiled binary.
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { openIonDist } from "../lib/ion-dist.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_SRC = path.join(repo, "patches", "linux", "fix_ion_dist_linux.nim");
const PATCH_BIN = process.env.CDB_ION_PATCH_BIN || path.join(repo, "patches", "linux", "fix_ion_dist_linux");
const ION_TREE = process.env.CDB_ION_TREE || path.join(repo, "tmp", "extract", "usr", "lib", "claude-desktop");
const EXPECTED_PATCHES = Number(/const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(PATCH_SRC, "utf8"))[1]);
const HINT =
  "This desktop has no device key, so Computer Use is not available in Cowork. Open Settings -> Extra -> Computer Use to fix it.";
const TITLE = "Not linked to this computer";
const MARKER = "/*cdb:keyless-hint*/";
const UPSTREAM_CONNECTED = "Claude can use the files and apps on your computer.";
// The lu producer's full result set (shared-29 cO, 4.4212.0), checked in [C].
const BINDING_STATES = ["inapplicable", "unknown", "unbound", "bound"];

let pass = 0;
let skipped = false;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${String(actual).slice(0, 160)}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${String(actual).slice(0, 400)}, expected ${String(expected).slice(0, 400)}`);
    failures.push(label);
  }
}
const count = (hay, needle) => hay.split(needle).length - 1;
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;
const esc = (s) => s.replace(/[$]/g, "\\$");

const CJ_RE = /function ([\w$]+)\([\w$]+\)\{return [\w$]+==="bound"\|\|[\w$]+==="unknown"\}/;
const HEAD_RE =
  /\{sessionId:([\w$]+),muted:([\w$]+),isScheduledTaskRun:[\w$]+,isDispatchSession:[\w$]+\}=[\w$]+,([\w$]+)=([\w$]+)!==void 0&&([\w$]+),([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=([\w$]+)==="bound",([\w$]+)=([\w$]+)\(([\w$]+)\?([\w$]+):void 0\)/;
const NJ_CALL_RE =
  /([\w$]+)\(([\w$]+),\{linkedHere:([\w$]+),usableFromHere:[\w$]+,computerName:[\w$]+,status:[\w$]+,connectedElsewhere:[\w$]+,linkOffer:[\w$]+,onLink:/;
const CALL_RE = /\{title:([\w$]+),statusLine:([\w$]+),iconLabel:([\w$]+)\}=([\w$]+)\(([\w$]+)\)/;
const PATCHED_CALL_RE =
  /\{title:[\w$]+,statusLine:[\w$]+,iconLabel:[\w$]+\}=__cdbKeylessLine\(([\w$]+)\(([\w$]+)\),\2\)/;
const BUILDER_RE =
  /function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\(\d+\),\{linkedHere:[\w$]+,usableFromHere:[\w$]+,computerName:[\w$]+,status:[\w$]+,/;
const LU_PRODUCER_RE =
  /if\(![\w$]+\|\|[\w$]+===null\)return"inapplicable";let ([\w$]+)=[\w$]+\([\w$]+,[\w$]+,[\w$]+\);return \1===void 0\?"unknown":\1===null\?"unbound":"bound"/;

// Source from `start` through the balanced body block (the first `{` after a
// `)`, so destructured parameters are skipped), skipping string literals.
function blockFrom(src, start) {
  let depth = 0;
  let q = null;
  for (let i = src.indexOf("){", start) + 1; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
function functionSource(src, name) {
  const start = src.indexOf("function " + name + "(");
  return start < 0 ? null : blockFrom(src, start);
}

function runPatch(dir) {
  const r = spawnSync(PATCH_BIN, [dir], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function snapshot(dir) {
  const v1 = path.join(dir, "assets", "v1");
  return Object.fromEntries(readdirSync(v1).map((f) => [f, readFileSync(path.join(v1, f), "utf8")]));
}
function nodeCheck(text) {
  const d = mkdtempSync(path.join(tmpdir(), "cdb-kh-chk-"));
  const f = path.join(d, "c.mjs");
  writeFileSync(f, text);
  const r = spawnSync("node", ["--check", f], { encoding: "utf8" });
  rmSync(d, { recursive: true, force: true });
  return r.status === 0;
}

// ------------------------------------------------------------ render slice
// The React compiler's memo runtime, verbatim from shared-frame (4.4212.0).
const MEMO_RUNTIME =
  'var J8=Symbol.for("react.memo_cache_sentinel");function J0(e,t){return e[t]===J8}function J1(e,t,n){return e[t]!==n}function J2(e,t,n,r){return e[t]!==n||e[t+1]!==r}function J3(e,t,n,r,i){return e[t]!==n||e[t+1]!==r||e[t+2]!==i}function J4(e,t,n,r,i,a){return e[t]!==n||e[t+1]!==r||e[t+2]!==i||e[t+3]!==a}function J5(e,t,...n){for(let r=0;r<n.length;r++)if(e[t+r]!==n[r])return!0;return!1}function K0(e,t,n){return e[t]=n,n}function K1(e,t,n,r){return e[t]=n,e[t+1]=r,r}function K2(e,t,n,r,i){return e[t]=n,e[t+1]=r,e[t+2]=i,i}function K3(e,t,n,r,i,a){return e[t]=n,e[t+1]=r,e[t+2]=i,e[t+3]=a,a}function K4(e,t,n,r,i,a,o){return e[t]=n,e[t+1]=r,e[t+2]=i,e[t+3]=a,e[t+4]=o,o}function K5(e,t,...n){for(let r=0;r<n.length;r++)e[t+r]=n[r];return n[n.length-1]}function I1(e,t,n,r){return e[t]=r,e[t+1]=n,n}function I2(e,t,n,r,i){return e[t]=r,e[t+1]=i,e[t+2]=n,n}function I3(e,t,n,r,i,a){return e[t]=r,e[t+1]=i,e[t+2]=a,e[t+3]=n,n}function I4(e,t,n,r,i,a,o){return e[t]=r,e[t+1]=i,e[t+2]=a,e[t+3]=o,e[t+4]=n,n}function I5(e,t,n,...r){for(let n=0;n<r.length;n++)e[t+n]=r[n];return e[t+r.length]=n,n}function Z1(e,t,n,r){return e[t]=r,n}function Z2(e,t,n,r,i){return e[t]=r,e[t+1]=i,n}function Z3(e,t,n,r,i,a){return e[t]=r,e[t+1]=i,e[t+2]=a,n}function Z4(e,t,n,r,i,a,o){return e[t]=r,e[t+1]=i,e[t+2]=a,e[t+3]=o,n}function Z5(e,t,n,...r){for(let n=0;n<r.length;n++)e[t+n]=r[n];return n}';

// Names of the real pieces, found by shape in a (pristine or patched) chunk.
function sliceNames(src) {
  const n = {};
  n.cj = CJ_RE.exec(src)[1];
  const wjm = /var ([\w$]+)=([\w$]+)\(function\([\w$]+\)\{let \$=([\w$]+)\(\d+\),\{sessionId:[\w$]+,muted:[\w$]+,isScheduledTaskRun:/.exec(src);
  [n.wj, n.memo, n.cache] = [wjm[1], wjm[2], wjm[3]];
  const head = HEAD_RE.exec(src);
  [n.lu, n.dj] = [head[7], head[12]];
  const njc = NJ_CALL_RE.exec(src);
  [n.jsx, n.nj] = [njc[1], njc[2]];
  n.wjSrc = blockFrom(src, src.indexOf("var " + n.wj + "=")) + ");";
  n.vLink = /,[\w$]+=([\w$]+)\([\w$]+\?[\w$]+:void 0,[\w$]+\),/.exec(n.wjSrc)[1];
  n.zLink = /\{link:[\w$]+,pending:[\w$]+\}=([\w$]+)\(/.exec(n.wjSrc)[1];
  n.ej = new RegExp(`[,(]${esc(n.jsx)}\\(([\\w$]+),\\{\\}\\)\\)`).exec(n.wjSrc)[1];
  n.use = new RegExp(`function ${esc(n.dj)}\\([\\w$]+\\)\\{let \\$=[\\w$]+\\(\\d+\\),[^;]*;return ([\\w$]+)\\(`).exec(src)[1];
  const njSrc = functionSource(src, n.nj);
  n.mj = /\{title:[\w$]+,statusLine:[\w$]+,iconLabel:[\w$]+\}=(?:__cdbKeylessLine\()?([\w$]+)\(/.exec(njSrc)[1];
  n.multi = /([\w$]+)\([\w$]+\.Root,\{delay:/.exec(njSrc)[1];
  n.fj = /\(([\w$]+),\{\.\.\.[\w$]+,title:/.exec(njSrc)[1];
  n.pj = /\(([\w$]+),\{statusLine:/.exec(functionSource(src, n.fj))[1];
  const mjSrc = functionSource(src, n.mj);
  n.aj = /[\w$]+=([\w$]+)\([\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+\),/.exec(mjSrc)[1];
  n.kj = /=[\w$]+===void 0\?([\w$]+):[\w$]+,/.exec(mjSrc)[1];
  n.intl = /,[\w$]+=([\w$]+)\(\),[\w$]+=[\w$]+!==void 0[,;]/.exec(mjSrc)[1];
  n.jj = /detail:[\w$]+==="connected"\?([\w$]+)\(/.exec(functionSource(src, n.aj))[1];
  const hStart = src.indexOf(MARKER);
  n.helperSrc = hStart < 0 ? "" : src.slice(hStart, src.indexOf("function " + n.cj + "(", hStart));
  return n;
}

const EL = Symbol("el");
// A self-describing stub for every import the slice does not control: callable
// (returns undefined), with stub members (Ee.Trigger), serialized by name.
function autostub(name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, p) {
      if (p === "__stub") return name;
      if (typeof p === "symbol" || p in t) return t[p];
      return autostub(name + "." + String(p));
    },
  });
}

// One fresh module instance of the slice. `env` controls the platform, the
// deviceLinkStore and the hooks the seat reads.
function makeSlice(src, env) {
  const n = sliceNames(src);
  const known = {};
  const sb = new Proxy(known, {
    has: () => true,
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "string" && k in globalThis) return globalThis[k];
      return typeof k === "string" ? autostub(k) : undefined;
    },
  });
  known.globalThis = sb;
  known.process = env.platform === undefined ? undefined : { platform: env.platform };
  const store = { listeners: [], syncReads: 0, state: env.store };
  known["claude.web"] =
    env.store === undefined
      ? undefined
      : {
          WindowState: {
            deviceLinkStore: {
              getStateSync() {
                store.syncReads++;
                if (store.state === "throw") throw new Error("No reply from the main process");
                return store.state;
              },
              onStateChange(cb) {
                store.listeners.push(cb);
                return () => {};
              },
            },
          },
        };
  const subs = [];
  const hooks = { binding: env.binding, linkedHere: env.linkedHere ?? false, status: env.status };
  const el = (type, props, key) => ({ [EL]: true, type, props: props || {}, key });
  Object.assign(known, {
    [n.cache]: (size) => Array(size).fill(Symbol.for("react.memo_cache_sentinel")),
    [n.memo]: (fn) => fn,
    [n.jsx]: el,
    [n.multi]: el,
    [n.use]: (subscribe, getSnapshot) => {
      subs.push(subscribe);
      return getSnapshot();
    },
    [n.lu]: () => hooks.binding,
    [n.dj]: (id) => (id === undefined ? false : hooks.linkedHere),
    [n.vLink]: (id) => (id === undefined || hooks.status === undefined ? undefined : { status: hooks.status }),
    [n.zLink]: () => ({ link: undefined, pending: false }),
    [n.intl]: () => ({
      formatMessage: (d, v) => d.defaultMessage.replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m)),
    }),
  });
  const pieces = [MEMO_RUNTIME, n.helperSrc, functionSource(src, n.cj), n.wjSrc];
  for (const f of [n.ej, n.kj, n.aj, n.jj, n.mj, n.nj, n.pj, n.fj]) pieces.push(functionSource(src, f));
  const ctx = vm.createContext(sb);
  vm.runInContext(pieces.join(";\n"), ctx);
  const components = new Set([known[n.wj], known[n.ej], known[n.nj], known[n.fj], known[n.pj]]);
  if (typeof known.__cdbKeylessIcon === "function") components.add(known.__cdbKeylessIcon);
  const trace = [];
  // Render components through, keep host / stub elements; functions and refs
  // collapse to markers so trees compare as JSON.
  function render(node) {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (Array.isArray(node)) return node.map(render);
    if (typeof node === "function") return "[fn]";
    if (typeof node !== "object") return node;
    if (!node[EL]) {
      if ("current" in node && Object.keys(node).length === 1) return "[ref]";
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, render(v)]));
    }
    const { type, props } = node;
    if (components.has(type)) {
      trace.push({ name: type === known.__cdbKeylessIcon ? "__cdbKeylessIcon" : type.name || "seat", props });
      return render(type(props));
    }
    const out = { type: typeof type === "string" ? type : type?.__stub ?? "?" };
    for (const [k, v] of Object.entries(props)) out[k] = render(v);
    return out;
  }
  const seatProps = { sessionId: "cse_1", muted: false, isScheduledTaskRun: env.scheduled, isDispatchSession: env.dispatch };
  return {
    n,
    known,
    store,
    subs,
    hooks,
    trace,
    seatRaw: () => known[n.wj](seatProps),
    renderSeat() {
      trace.length = 0;
      return render(el(known[n.wj], seatProps));
    },
    emit(state) {
      store.state = state;
      for (const l of store.listeners) l(state);
    },
  };
}

const KEYLESS = { appStartedMs: 1, connected: true, idSource: "keyless", presentedDeviceId: "abc", recentGaps: [] };
const KEYED = { appStartedMs: 1, connected: true, idSource: "keyed", presentedDeviceId: "abc", recentGaps: [] };
const DOWN = { appStartedMs: 1, connected: false, downSinceMs: 2, downCause: "closed", recentGaps: [] };

function findAll(tree, pred, out = []) {
  if (Array.isArray(tree)) tree.forEach((t) => findAll(t, pred, out));
  else if (tree && typeof tree === "object") {
    if (pred(tree)) out.push(tree);
    Object.values(tree).forEach((v) => findAll(v, pred, out));
  }
  return out;
}
const J = (x) => JSON.stringify(x);

function behaviorTable(tag, pristineSrc, patchedSrc) {
  const both = (env) => [makeSlice(pristineSrc, env), makeSlice(patchedSrc, env)];
  const same = (label, env) => {
    const [a, b] = both(env);
    const ta = a.renderSeat();
    const tb = b.renderSeat();
    check(`${tag} ${label}: tree identical to upstream`, J(tb), J(ta));
    return [ta, tb, a, b];
  };

  // The hint case: unbound + keyless + Linux.
  {
    const [up] = both({ platform: "linux", store: KEYLESS, binding: "unbound" });
    const p = makeSlice(patchedSrc, { platform: "linux", store: KEYLESS, binding: "unbound" });
    check(`${tag} unbound keyless linux: upstream renders nothing`, J(up.renderSeat()), "null");
    const t = p.renderSeat();
    const names = p.trace.map((x) => x.name);
    check(`${tag} unbound keyless linux: renders upstream Nj`, names.includes(p.n.nj), true);
    const nj = p.trace.find((x) => x.name === p.n.nj)?.props ?? {};
    check(`${tag} unbound keyless linux: Nj props`, J(nj), J({ linkedHere: false, computerName: TITLE, muted: false, __cdbKeyless: true }));
    const trigger = findAll(t, (x) => x["data-testid"] === "cowork-computer-link-indicator")[0];
    check(`${tag} unbound keyless linux: icon trigger rendered`, trigger?.icon, "Laptop");
    check(`${tag} unbound keyless linux: amber indicator`, trigger?.indicator?.color, "var(--cds-fill-warning)");
    check(`${tag} unbound keyless linux: aria-label`, trigger?.["aria-label"], `${TITLE}, No device key`);
    check(`${tag} unbound keyless linux: no data-status`, trigger?.["data-status"], null);
    const root = findAll(t, (x) => typeof x.type === "string" && x.type.endsWith(".Root") && "delay" in x)[0];
    check(`${tag} unbound keyless linux: hover description is the hint`, root?.description, HINT);
    const detail = findAll(t, (x) => x["data-testid"] === "cowork-computer-link-status-detail")[0];
    check(`${tag} unbound keyless linux: popover detail`, detail?.children, HINT);
    const title = findAll(t, (x) => x.type === "span" && x.children === TITLE && typeof x.className === "string" && x.className.includes("font-medium"));
    check(`${tag} unbound keyless linux: popover title`, title.length, 1);
    const status = findAll(t, (x) => x["data-testid"] === "cowork-computer-link-status")[0];
    check(`${tag} unbound keyless linux: status text`, J(status?.children?.[1]?.children?.[0]), J("No device key"));
    check(
      `${tag} unbound keyless linux: no actions (sign in / link / manage)`,
      findAll(t, (x) => /^cowork-computer-link-(sign-in|action|manage|now|cancel)$/.test(x["data-testid"] ?? "")).length,
      0
    );
    check(`${tag} unbound keyless linux: no em-dash`, /\u2014/.test(J(t)), false);
    check(`${tag} unbound keyless linux: one store subscription`, p.subs.length, 1);
    check(`${tag} unbound keyless linux: one sync read`, p.store.syncReads, 1);
    p.renderSeat();
    check(`${tag} re-render: still one sync read`, p.store.syncReads, 1);
    check(`${tag} re-render: one store listener installed`, p.store.listeners.length, 1);

    // keyless -> keyed flip: the subscriber is told, the snapshot changes, the
    // next render is upstream's (nothing).
    let told = 0;
    const unsub = (p.subs[0] ?? (() => () => {}))(() => told++);
    p.emit(KEYED);
    check(`${tag} flip to keyed: subscriber notified`, told, 1);
    check(`${tag} flip to keyed: renders nothing (= upstream)`, J(p.renderSeat()), "null");
    p.emit(DOWN);
    check(`${tag} link down: renders nothing`, J(p.renderSeat()), "null");
    p.emit(KEYLESS);
    check(`${tag} flip back to keyless: subscriber notified`, told, 3);
    check(`${tag} flip back to keyless: hint again`, findAll(p.renderSeat(), (x) => x.description === HINT).length, 1);
    unsub();
    p.emit(KEYED);
    check(`${tag} unsubscribed: no further notifications`, told, 3);

    // Stable identity of the rewritten builder result (Nj's memo slots stay hits).
    const r = { title: TITLE, statusLine: undefined, iconLabel: TITLE };
    const m1 = p.known.__cdbKeylessLine(r, nj);
    check(`${tag} line helper: stable identity`, p.known.__cdbKeylessLine(r, nj) === m1, true);
    check(`${tag} line helper: other Nj props -> upstream object (===)`, p.known.__cdbKeylessLine(r, { linkedHere: true, status: "connected" }) === r, true);
  }
  for (const [label, extra] of [
    ["scheduled task run", { scheduled: true }],
    ["dispatch session", { dispatch: true }],
  ]) {
    const p = makeSlice(patchedSrc, { platform: "linux", store: KEYLESS, binding: "unbound", ...extra });
    check(`${tag} unbound keyless linux ${label}: hint`, findAll(p.renderSeat(), (x) => x.description === HINT).length, 1);
  }

  // Everything else: identical to upstream.
  same("unbound keyed linux", { platform: "linux", store: KEYED, binding: "unbound" });
  const [bt] = same("bound here keyless linux", { platform: "linux", store: KEYLESS, binding: "bound", linkedHere: true, status: "connected" });
  check(`${tag} bound here keyless linux: upstream detail`, findAll(bt, (x) => x.description === UPSTREAM_CONNECTED).length, 1);
  same("bound elsewhere keyless linux", { platform: "linux", store: KEYLESS, binding: "bound", linkedHere: false, status: "connected" });
  same("bound here asleep keyless linux", { platform: "linux", store: KEYLESS, binding: "bound", linkedHere: true, status: "disconnected" });
  same("bound here keyed linux", { platform: "linux", store: KEYED, binding: "bound", linkedHere: true, status: "connected" });
  const [ut] = same("unknown keyless linux (loading slot)", { platform: "linux", store: KEYLESS, binding: "unknown" });
  check(`${tag} unknown: upstream's empty slot`, findAll(ut, (x) => x["data-testid"] === "cowork-computer-link-indicator-slot").length, 1);
  same("inapplicable keyless linux", { platform: "linux", store: KEYLESS, binding: "inapplicable" });
  for (const platform of ["darwin", "win32", undefined]) {
    const [, , , b] = same(`unbound keyless ${platform ?? "no window.process"}`, { platform, store: KEYLESS, binding: "unbound" });
    check(`${tag} unbound keyless ${platform ?? "no window.process"}: seat returns null itself`, b.seatRaw(), null);
    check(`${tag} unbound keyless ${platform ?? "no window.process"}: store never read`, b.store.syncReads + b.store.listeners.length, 0);
  }
  for (const [label, store] of [
    ["no claude.web bridge", undefined],
    ["getStateSync throws", "throw"],
    ["local link down", DOWN],
    ["idSource none", { connected: true, idSource: "none" }],
  ]) {
    same(`unbound linux, ${label}`, { platform: "linux", store, binding: "unbound" });
  }
  {
    const p = makeSlice(patchedSrc, { platform: "linux", store: "throw", binding: "unbound" });
    p.renderSeat();
    p.emit(KEYLESS);
    check(`${tag} getStateSync threw, then an update says keyless: hint`, findAll(p.renderSeat(), (x) => x.description === HINT).length, 1);
  }
}

// ---------------------------------------------------------------- fixture
// The verbatim 4.4212.0 functions of the popover chunk (c21f11e6d-CVg-B0ni.js),
// in their upstream order; Oj and the rest of the chunk are left out.
const FIX_C = [
  "function Cj(e){return e===\"bound\"||e===\"unknown\"}",
  "var wj=X(function(e){let $=J9(19),{sessionId:t,muted:n,isScheduledTaskRun:r,isDispatchSession:i}=e,a=n!==void 0&&n,o=lu(t),s=o===\"bound\",c=Dj(s?t:void 0),l=em(s?t:void 0),u=J1($,0,o)?K1($,0,o,{locateElsewhere:!0,bindingState:o,seat:\"header\"}):$[1],d=V_(s?t:void 0,u),f=Oj(d?.connectedElsewhere),p=J2($,2,i,r)?K2($,2,i,r,{isScheduledTaskRun:r,isDispatchSession:i,seat:\"header\"}):$[4],m=B_(s&&!c?t:void 0,p),h=Ht(\"cowork_remote_late_link_seats_off\",m!==void 0)?void 0:m,{link:g,pending:_}=z_(h,\"header\");L_(h,\"header\");let v=G(null),y=G(null),b=J1($,5,g)?K1($,5,g,()=>{g().catch(Ij).finally(()=>{let e=document.activeElement;(e===null||e===document.body||y.current?.contains(e))&&v.current?.focus()})}):$[6],x=Tp(),S=dv(),C=Om();if(!Cj(o))return null;if(!s)return J0($,7)?K0($,7,q(Ej,{})):$[7];let w=C||c,T=d?.status,E=x?S:void 0;return J5($,8,l,f,c,a,b,_,h,w,T,E)?K5($,8,l,f,c,a,b,_,h,w,T,E,q(Nj,{linkedHere:c,usableFromHere:w,computerName:l,status:T,connectedElsewhere:f,linkOffer:h,onLink:b,linkPending:_,onManageComputers:E,muted:a,triggerRef:v,cardRef:y})):$[18]});",
  "function Tj(){}",
  "function Ej(){let $=J9(1);return J0($,0)?K0($,0,q(\"span\",{\"aria-hidden\":!0,...At(Rh()),className:\"inline-flex h-control w-control shrink-0\",\"data-testid\":\"cowork-computer-link-indicator-slot\"})):$[0]}",
  "function Dj(e){let $=J9(4),t=J1($,0,e)?K1($,0,e,t=>e?ji(t):Tj):$[1],n=J1($,2,e)?K1($,2,e,()=>!!e&&Wi(e)!==void 0):$[3];return Ue(t,n,n)}",
  "function kj(e,{orgName:t,currentOrgName:n}){return e.formatMessage({defaultMessage:\"Claude Desktop on this task\\u2019s computer is switched to {otherOrg}. Switch it to {currentOrg} to reconnect.\",id:\"uH2p7VS6Rf\"},{otherOrg:t,currentOrg:n})}",
  "function Aj(e,t,n,r,i,a,o,s){if(t===void 0||t===\"unknown\")return i===void 0?void 0:{text:i};if(t!==\"connected\"&&o){let t=e.formatMessage({defaultMessage:\"Sign in again to access local files on your computer.\",id:\"52YJtcI6Bv\"});return{dotColor:\"var(--cds-fill-warning)\",text:t,label:t}}if(t!==\"connected\"&&n){let t=r(e,n);return{dotColor:\"var(--cds-fill-warning)\",text:t,label:t}}let c=t===\"connected\"?e.formatMessage({defaultMessage:\"Connected\",id:\"IvjoDSPGEQ\"}):e.formatMessage({defaultMessage:\"Asleep or app closed\",id:\"5I/DeyD+rW\"});return{dotColor:t===\"connected\"?\"var(--cds-fill-success)\":\"var(--cds-fill-warning)\",text:i??a??c,detail:t===\"connected\"?jj(e,s):i===void 0?void 0:a,label:c}}",
  "function jj(e,t){return t?e.formatMessage({defaultMessage:\"Claude can use the files and apps on your computer.\",id:\"cQTH9F2BGU\"}):e.formatMessage({defaultMessage:\"Claude can use its files and apps only from the Claude desktop app on that computer.\",id:\"myH5Qe0xBl\"})}",
  "function Mj(e){let $=J9(22),{linkedHere:t,usableFromHere:n,computerName:r,status:i,connectedElsewhere:a,formatConnectedElsewhere:o,statusLabel:s,statusText:c,onSignIn:l,linkOffer:u}=e,d=n===void 0||n,f=o===void 0?kj:o,p=Rs(),m=l!==void 0,h;h=u?.kind===\"rebind\"?J1($,0,p)||J1($,1,u.otherComputerName)?I1($,1,Z1($,0,u.otherComputerName??p.formatMessage({defaultMessage:\"Linked to another computer\",id:\"4+uJa18sM/\"}),p),u.otherComputerName):$[2]:r===void 0?t?J1($,3,p)?K1($,3,p,p.formatMessage({defaultMessage:\"Linked to this computer\",id:\"eBbKvh1X25\"})):$[4]:J1($,5,p)?K1($,5,p,Do(p)):$[6]:r;let g,_;J5($,7,a,f,p,m,i,s,c,h,d)?(g=Aj(p,i,a,f,s,c,m,d),_=g?.label===void 0?h:p.formatMessage({defaultMessage:\"{name}, {status}\",id:\"lsc+L9Axkf\"},{name:h,status:g.label}),K5($,7,a,f,p,m,i,s,c,h,d,g,_)):(g=$[16],_=$[17]);let v=_;return J3($,18,v,g,h)?K3($,18,v,g,h,{title:h,statusLine:g,iconLabel:v}):$[21]}",
  "function Nj(e){let $=J9(49),t,n,r;J1($,0,e)?({triggerRef:r,cardRef:t,...n}=e,K3($,0,e,t,n,r)):(t=$[1],n=$[2],r=$[3]);let{onSignIn:i,linkOffer:a,onLink:o,onManageComputers:s}=n,c=n.muted??!1,l=Rs(),u=Ge(),{title:d,statusLine:f,iconLabel:p}=Mj(n),m=J1($,4,f)?K1($,4,f,f?.dotColor===void 0?void 0:q(rt,{color:f.dotColor,animate:!1})):$[5],h=i!==void 0||a!==void 0&&o!==void 0||s!==void 0,g=n.onCardOpenChange,_=h?void 0:f?.detail,v=J2($,6,h,l)?K2($,6,h,l,h&&{interactive:!0,interactiveHint:l.formatMessage({defaultMessage:\"Computer actions available\",id:\"/3k664jCM5\"})}):$[8],y=J0($,9)?K0($,9,Rh()):$[9],b=c?\"text-muted-as-secondary\":\"text-secondary\",x=J1($,10,b)?K1($,10,b,Qe(\"draggable-none\",b)):$[11],S=m?n.status:void 0,C=J5($,12,p,m,x,S,r)?K5($,12,p,m,x,S,r,q(Ee.Trigger,{render:q(Pt,{ref:r,variant:\"ghost\",size:y,iconOnly:!0,icon:\"Laptop\",indicator:m,\"aria-label\":p,tooltip:!1,className:x,\"data-testid\":\"cowork-computer-link-indicator\",\"data-status\":S})})):$[17],w=J4($,18,n,f,d,u)?K4($,18,n,f,d,u,q(Fj,{...n,title:d,titleId:u,statusLine:f})):$[22],T=J3($,23,t,w,u)?K3($,23,t,w,u,q(Ee.Popup,{ref:t,side:\"bottom\",align:\"start\",padding:\"none\",\"aria-labelledby\":u,className:\"[--preview-card-max-w:280px] [--preview-card-min-w:280px]\",children:w})):$[26],E=J5($,27,n.onCardOpenChange,T,_,v,C)?I5($,27,K(Ee.Root,{delay:150,onOpenChange:g,description:_,...v,children:[C,T]}),n.onCardOpenChange,T,_,v,C):$[32],D=J2($,33,p,l)||J1($,35,n.linkOffer?.kind)||J1($,36,n.linkWaiting)||J1($,37,f?.label)?I1($,37,Z1($,36,Z1($,35,Z2($,33,n.linkWaiting===!0?R_(l,n.linkOffer?.kind):f?.label===void 0?\"\":p,p,l),n.linkOffer?.kind),n.linkWaiting),f?.label):$[38],O=J1($,39,D)?K1($,39,D,q(\"span\",{className:\"sr-only\",children:D})):$[40],k=J2($,41,a,o)||J1($,43,n.linkNote)?I1($,43,Z2($,41,a!==void 0&&o!==void 0&&n.linkNote!==void 0&&q(\"span\",{className:\"sr-only\",children:n.linkNote}),a,o),n.linkNote):$[44];return J3($,45,E,O,k)?K3($,45,E,O,k,K(\"span\",{role:\"status\",className:\"inline-flex\",children:[O,k,E]})):$[48]}",
  "function Pj(e){let $=J9(12),{statusLine:t,\"data-testid\":n}=e,r=n===void 0?\"cowork-computer-link-status\":n,i=J1($,0,t.dotColor)?I1($,0,t.dotColor!==void 0&&q(\"span\",{\"aria-hidden\":!0,className:\"mt-1.5 shrink-0\",children:q(rt,{color:t.dotColor,animate:!1})}),t.dotColor):$[1],a=J2($,2,t.detail,r)?I2($,2,t.detail!==void 0&&K(We,{children:[\" \",q(\"span\",{className:\"block\",\"data-testid\":`${r}-detail`,children:t.detail})]}),t.detail,r):$[4],o=J2($,5,t.text,a)?I2($,5,K(\"span\",{className:\"min-w-0 [overflow-wrap:anywhere]\",children:[t.text,a]}),t.text,a):$[7];return J3($,8,i,o,r)?K3($,8,i,o,r,K(\"span\",{\"data-testid\":r,className:\"flex items-start gap-xs text-footnote text-muted-as-secondary\",children:[i,o]})):$[11]}",
  "function Fj(e){let $=J9(25),{onSignIn:t,linkOffer:n,onLink:r,linkPending:i,linkWaiting:a,linkNote:o,linkNow:s,linkCancel:c,onManageComputers:l,manageComputersLabel:u,title:d,titleId:f,statusLine:p}=e,m=i!==void 0&&i,h=a!==void 0&&a,g=Rs(),_=n!==void 0&&r!==void 0,v=t!==void 0||_||l!==void 0,y=J2($,0,d,f)?K2($,0,d,f,q(\"span\",{id:f,className:\"truncate text-body font-medium text-primary [unicode-bidi:plaintext] [text-align:-webkit-match-parent] supports-[text-align:match-parent]:[text-align:match-parent]\",children:d})):$[2],b=J1($,3,p)?K1($,3,p,p&&q(Pj,{statusLine:p})):$[4],x=J2($,5,y,b)?K2($,5,y,b,K(\"div\",{className:\"flex flex-col gap-0.5 px-md py-sm\",children:[y,b]})):$[7],S=J5($,8,_,v,g,c,o,s,n,m,h,u,r,l,t)?K5($,8,_,v,g,c,o,s,n,m,h,u,r,l,t,v&&K(\"div\",{className:\"flex flex-col\",children:[q(\"div\",{\"aria-hidden\":!0,className:\"my-1 h-px bg-border\"}),t&&q(Pt,{variant:\"ghost\",className:\"w-full justify-start\",onClick:t,\"data-testid\":\"cowork-computer-link-sign-in\",children:q(Q,{defaultMessage:\"Sign in\",id:\"SQJto27U8S\"})}),_&&q(Pt,{variant:\"ghost\",className:\"w-full justify-start\",onClick:r,busy:m,disabled:h,\"data-testid\":\"cowork-computer-link-action\",children:h?R_(g,n.kind):n.kind===\"late_link\"?q(Q,{defaultMessage:\"Link to this computer\",id:\"sQkRkL9ns5\"}):q(Q,{defaultMessage:\"Use this computer instead\",id:\"aToBshsel+\"})}),_&&o!==void 0&&q(\"span\",{className:\"px-md py-xs text-footnote text-secondary\",\"data-testid\":\"cowork-computer-link-note\",children:o}),_&&s&&q(Pt,{variant:\"ghost\",className:\"w-full justify-start\",onClick:s.onClick,disabled:m||s.disabled,\"aria-description\":s.hint,\"data-testid\":\"cowork-computer-link-now\",children:s.label}),_&&c&&q(Pt,{variant:\"ghost\",className:\"w-full justify-start\",onClick:c.onClick,disabled:m||c.disabled,\"aria-description\":c.hint,\"data-testid\":\"cowork-computer-link-cancel\",children:c.label}),l&&q(Pt,{variant:\"ghost\",className:\"w-full justify-start\",onClick:l,\"data-testid\":\"cowork-computer-link-manage\",children:q(\"span\",{className:\"truncate\",children:u??Zi({id:\"v1wzg8\",intl:g})})})]})):$[21];return J2($,22,x,S)?K2($,22,x,S,K(\"div\",{className:\"flex flex-col p-1\",children:[x,S]})):$[24]}",
  "function Ij(){}",
  "export{Nj as t};",
].join("");
const FIX_A = 'var e={id:"plugins",mountPath:{mac:"/Library/Application Support/Claude/org-plugins",win:"%ProgramFiles%\\\\Claude\\\\org-plugins"}};export{e as t};';
const FIX_B = "function f(r,W,t){return r===W.Win32?t.win:t.mac}export{f as t};";

function writeFixture(files) {
  const d = mkdtempSync(path.join(tmpdir(), "cdb-kh-fx-"));
  mkdirSync(path.join(d, "assets", "v1"), { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(path.join(d, "assets", "v1", n), t);
  return d;
}

// Undo our three splices; must give back the pristine chunk exactly.
function unsplice(c) {
  const n = sliceNames(c);
  const m = PATCHED_CALL_RE.exec(c);
  return c
    .replace(n.helperSrc, "")
    .replace(`=__cdbKeylessLine(${m[1]}(${m[2]}),${m[2]})`, `=${m[1]}(${m[2]})`)
    .replace(/return __cdbKeylessSeat\(([\w$]+),[\w$]+\);/, "return null;");
}

let runnable = false;
try {
  accessSync(PATCH_BIN, constants.X_OK);
  runnable = true;
} catch {}

console.log("[A] compiled patch on the verbatim 4.4212.0 functions");
let patchedFixture = null;
if (!runnable) {
  console.log("  SKIP patch binary not compiled (cd patches && make)");
  skipped = true;
} else {
  check("fixture C parses", nodeCheck(FIX_C), true);
  const d = writeFixture({ "ca.js": FIX_A, "cb.js": FIX_B, "cc.js": FIX_C });
  const r1 = runPatch(d);
  check("applies (exit 0)", r1.status, 0);
  check("full counter", r1.out.includes(`[PASS] All ${EXPECTED_PATCHES} patches applied`), true);
  check("reports sub-patch C", /\[OK\] keyless device hint: 1 match \(cc\.js\)/.test(r1.out), true);
  const s1 = snapshot(d);
  const c = s1["cc.js"];
  patchedFixture = c;
  check("builder call wrapped once", countRe(c, PATCHED_CALL_RE), 1);
  check("upstream builder call gone", countRe(c, CALL_RE), 0);
  check("seat guard rewritten once", count(c, "if(!Cj(o))return __cdbKeylessSeat(o,a);if(!s)return "), 1);
  check("upstream seat guard gone", count(c, "if(!Cj(o))return null;"), 0);
  check("helper once", count(c, MARKER), 1);
  const helperSrc = sliceNames(c).helperSrc;
  check("helper directly precedes Cj", helperSrc.length > 0 && c.includes(helperSrc + "function Cj(e){"), true);
  check("helper uses the chunk's jsx, store hook and Nj", /\?q\(__cdbKeylessIcon,/.test(helperSrc) && /return Ue\(__cdbKeylessSub,/.test(helperSrc) && /\?q\(Nj,\{linkedHere:!1,/.test(helperSrc), true);
  check("helper adds no link actions", /linkOffer|onLink|onManageComputers|onClick/.test(helperSrc), false);
  check("only our three splices differ", unsplice(c) === FIX_C, true);
  check("memo cache slots untouched", J(c.match(/J9\(\d+\)/g)), J(FIX_C.match(/J9\(\d+\)/g)));
  check("patched C passes node --check", nodeCheck(c), true);
  const r2 = runPatch(d);
  check("second run exit 0", r2.status, 0);
  check("second run says already applied", /\[OK\] keyless device hint: already applied/.test(r2.out), true);
  check("second run byte-identical", J(snapshot(d)) === J(s1), true);
  rmSync(d, { recursive: true, force: true });

  const refusals = [
    ["helper missing", { "cc.js": c.replace(helperSrc, "") }],
    ["seat guard unpatched", { "cc.js": c.replace("return __cdbKeylessSeat(o,a);", "return null;") }],
    ["builder call unwrapped", { "cc.js": c.replace("=__cdbKeylessLine(Mj(n),n)", "=Mj(n)") }],
    ["helper text altered", { "cc.js": c.replace('idSource==="keyless"', 'idSource==="keyed"') }],
    ["helper moved off Cj", { "cc.js": c.replace(helperSrc, "").replace("function Tj(){}", helperSrc + "function Tj(){}") }],
    ["old keyless helper present", { "cc.js": FIX_C, "cz.js": "function __cdbKeylessHint(r,p){return r}" }],
    ["seat predicate changed (pristine)", { "cc.js": FIX_C.replace('e==="bound"||e==="unknown"', 'e==="bound"||e==="loading"') }],
    ["seat head renamed (pristine)", { "cc.js": FIX_C.replace("{sessionId:t,muted:n,", "{sessionId:t,quiet:n,") }],
    ["seat data flow changed (pristine)", { "cc.js": FIX_C.replace('s=o==="bound",c=Dj(s?t:void 0)', 's=o==="bound",c=Dj(o?t:void 0)') }],
    ["seat guard changed (pristine)", { "cc.js": FIX_C.replace("if(!Cj(o))return null;", "if(!Cj(o))return void 0;") }],
    ["seat popover render changed (pristine)", { "cc.js": FIX_C.replace("q(Nj,{linkedHere:c,usableFromHere:w,", "q(Nj,{usableFromHere:w,linkedHere:c,") }],
    ["linkedHere hook not a store subscription (pristine)", { "cc.js": FIX_C.replace("return Ue(t,n,n)}", "return Ue(t,n)}") }],
    ["builder props renamed (pristine)", { "cc.js": FIX_C.replace("{linkedHere:t,usableFromHere:n,", "{boundHere:t,usableFromHere:n,") }],
    ["builder call moved out of Nj (pristine)", { "cc.js": FIX_C.replace("{title:d,statusLine:f,iconLabel:p}=Mj(n)", "q=Mj(n)") }],
    ["signature in two files", { "cc.js": FIX_C, "cd.js": FIX_C }],
    ["signature missing", { "cc.js": FIX_C.replace("cQTH9F2BGU", "XXXXXXXXXX") }],
  ];
  for (const [label, files] of refusals) {
    const fd = writeFixture({ "ca.js": FIX_A, "cb.js": FIX_B, ...files });
    const r = runPatch(fd);
    check(`refused: ${label}`, r.status !== 0 && /\[FAIL\] keyless device hint/.test(r.out), true);
    rmSync(fd, { recursive: true, force: true });
  }
}

console.log("\n[B] the real seat -> Nj render path (fixture), pristine vs patched");
if (patchedFixture) behaviorTable("fx", FIX_C, patchedFixture);
else console.log("  SKIP needs [A]");

console.log("\n[C] the real SPA");
const ion = openIonDist(ION_TREE);
if (!runnable || !ion) {
  console.log(`  SKIP ${!runnable ? "patch binary not compiled" : "no ion-dist under " + ION_TREE}`);
  skipped = true;
} else {
  const d = mkdtempSync(path.join(tmpdir(), "cdb-kh-ion-"));
  const v1 = path.join(d, "assets", "v1");
  mkdirSync(v1, { recursive: true });
  const jsFiles = ion.list("assets/v1").filter((f) => f.endsWith(".js"));
  for (const f of jsFiles) writeFileSync(path.join(v1, f), ion.read("assets/v1/" + f));
  const before = snapshot(d);
  const sigFiles = jsFiles.filter((f) => before[f].includes("cQTH9F2BGU"));
  check("pristine: signature in exactly one file", sigFiles.length, 1);
  const pf = before[sigFiles[0]] || "";
  check("pristine: seat predicate once", countRe(pf, CJ_RE), 1);
  check("pristine: seat head once", countRe(pf, HEAD_RE), 1);
  check("pristine: seat popover render once", countRe(pf, NJ_CALL_RE), 1);
  check("pristine: builder call once", countRe(pf, CALL_RE), 1);
  check("pristine: builder once", countRe(pf, BUILDER_RE), 1);
  check("pristine: call's callee is the builder", CALL_RE.exec(pf)?.[4], BUILDER_RE.exec(pf)?.[1]);
  check("pristine: nothing of ours", jsFiles.filter((f) => /__cdbKeyless/.test(before[f])).length, 0);
  // The binding-state hook: the module the chunk imports it from must
  // export a function whose snapshot is exactly the traced producer.
  {
    const lu = HEAD_RE.exec(pf)?.[7];
    const imp = new RegExp(`import\\{([^}]*)\\}from"\\./([^"]+)"`, "g");
    let srcFile, srcAlias;
    for (const m of pf.matchAll(imp)) {
      const hit = m[1].split(",").find((x) => x.endsWith(" as " + lu));
      if (hit) [srcAlias, srcFile] = [hit.split(" as ")[0], m[2]];
    }
    const mod = before[srcFile] || "";
    const exp = [...mod.matchAll(/export\{([^}]*)\}/g)].pop()?.[1] ?? "";
    const local = exp.split(",").find((x) => x.endsWith(" as " + srcAlias))?.split(" as ")[0];
    const fn = local ? functionSource(mod, local) : "";
    check(`real: binding hook ${lu} comes from ${srcFile}`, Boolean(fn), true);
    check("real: its snapshot is the traced producer", LU_PRODUCER_RE.test(fn || ""), true);
    const states = (fn || "").match(/"(inapplicable|unknown|unbound|bound)"/g) || [];
    check("real: producer's states", J([...new Set(states.map((s) => s.slice(1, -1)))]), J(BINDING_STATES));
    check("real: producer exists once across the SPA", jsFiles.reduce((a, f) => a + countRe(before[f], LU_PRODUCER_RE), 0), 1);
  }
  const r1 = runPatch(d);
  check("real: applies (exit 0)", r1.status, 0);
  check("real: full counter", r1.out.includes(`[PASS] All ${EXPECTED_PATCHES} patches applied`), true);
  const after = snapshot(d);
  const changed = jsFiles.filter((f) => after[f] !== before[f]);
  check("real: exactly three files changed (A, B, C)", changed.length, 3);
  const c = after[sigFiles[0]];
  const names = sliceNames(c);
  check("real: C differs only by our three splices", unsplice(c) === pf, true);
  check("real: helper inserted immediately before the seat predicate", c.indexOf(names.helperSrc + "function " + names.cj + "(") >= 0, true);
  check("real: memo cache slots untouched", J(c.match(/J9\(\d+\)/g)), J(pf.match(/J9\(\d+\)/g)));
  check("real: patched C passes node --check", nodeCheck(c), true);
  const r2 = runPatch(d);
  check("real: second run exit 0", r2.status, 0);
  check("real: second run byte-identical", J(snapshot(d)) === J(after), true);
  behaviorTable("real", pf, c);
  rmSync(d, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) {
  console.log(`${pass} checks passed; some sections SKIPPED`);
  process.exit(SKIP_EXIT);
}
console.log("ALL " + pass + " CHECKS PASSED");
