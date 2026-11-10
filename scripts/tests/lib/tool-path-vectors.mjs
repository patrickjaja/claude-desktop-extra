// Shared behaviour vectors for the two copies of the TOOL PATH / APP PATH
// helpers: js/tool_path.js (globalThis.__cdbToolPath, every patch but Computer
// Use) and the private copy in js/cu_linux_executor.js (_startedRaw,
// _startedPath, _toolPath, _toolCmd, _dirTrusted, _toolIgn). Both are run
// against every vector by scripts/tests/core/test-tool-path-resolver.mjs, so
// the copies cannot drift apart.
//
// A vector is a stub host (directories with owner and writability, symlinks
// with owner, executable files), an env, and a list of steps. Each step calls
// one helper and states the expected result, or mutates the env / the host
// between calls.
import vm from "node:vm";
import path from "node:path";

// Upstream's narrowed PATH on a host whose /usr/local is root-owned.
export const NARROWED = "/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin:/snap/bin:/run/current-system/sw/bin:/run/current-system/profile/bin";
const R = (ro = "EACCES") => ({ uid: 0, ro });
const U = () => ({ uid: 1000, ro: null });
// Every host has these: a root-owned, read-only system tree and a user home.
const BASE_DIRS = {
  "/": R(), "/usr": R(), "/usr/bin": R(), "/bin": R(), "/usr/sbin": R(), "/sbin": R(),
  "/usr/local": R(), "/usr/local/bin": R(), "/usr/local/sbin": R(),
  "/home": R(), "/home/u": U(), "/home/u/.local": U(), "/home/u/.local/bin": U(),
  "/nix": R(), "/nix/store": R("EROFS"),
  "/etc": R(), "/etc/profiles": R(), "/etc/profiles/per-user": R(),
  "/run": R(), "/run/current-system": R(), "/opt": R()
};
const STORE = "/nix/store/aaaa-xdg-utils-1.2/bin";
const HM = "/nix/store/bbbb-home-manager-path";
const PROF = "/nix/store/cccc-user-profile";
const narrowed = (started) => ({ PATH: NARROWED, CLAUDE_DESKTOP_NARROWED_PATH: NARROWED, CLAUDE_DESKTOP_STARTED_PATH: started });

// The stub fs: dirs {path: {uid, ro: "EACCES"|"EROFS"|null}}, links
// {path: absolute target}, linkUids {path: uid} (default 0), files [abs path]
// (executable regular files; a path through a link resolves like the kernel).
export function makeHost(spec) {
  const host = {
    dirs: { ...BASE_DIRS, ...(spec.dirs || {}) },
    links: { ...(spec.links || {}) },
    linkUids: { ...(spec.linkUids || {}) },
    files: new Set(spec.files || []),
    // root: the app runs as uid 0 - every W_OK check succeeds (EROFS aside).
    root: !!spec.root
  };
  const real = (p) => {
    let s = path.resolve(String(p));
    for (let n = 0, hit = true; hit && n < 40; n++) {
      hit = false;
      for (const [a, b] of Object.entries(host.links)) {
        if (s === a || s.startsWith(a + "/")) { s = path.resolve(b + s.slice(a.length)); hit = true; break; }
      }
    }
    return s;
  };
  const err = (code, p) => { const e = new Error(code + ": " + p); e.code = code; return e; };
  host.fs = {
    constants: { X_OK: 1, W_OK: 2 },
    accessSync(p, mode) {
      const r = real(p);
      if (mode === 2) {
        const d = host.dirs[r];
        if (!d) { if (host.files.has(r)) throw err("EACCES", p); throw err("ENOENT", p); }
        if (d.ro === "EROFS" || (d.ro && !host.root)) throw err(d.ro, p);
        return;
      }
      if (host.files.has(r) || host.dirs[r]) return;
      throw err("ENOENT", p);
    },
    statSync(p) {
      const r = real(p);
      if (host.dirs[r]) return { uid: host.dirs[r].uid, isDirectory: () => true, isSymbolicLink: () => false };
      if (host.files.has(r)) return { uid: 0, isDirectory: () => false, isSymbolicLink: () => false };
      throw err("ENOENT", p);
    },
    lstatSync(p) {
      const k = String(p);
      if (k in host.links) return { uid: k in host.linkUids ? host.linkUids[k] : 0, isDirectory: () => false, isSymbolicLink: () => true };
      if (host.dirs[k]) return { uid: host.dirs[k].uid, isDirectory: () => true, isSymbolicLink: () => false };
      if (host.files.has(k)) return { uid: 0, isDirectory: () => false, isSymbolicLink: () => false };
      throw err("ENOENT", p);
    },
    readlinkSync(p) { if (String(p) in host.links) return host.links[String(p)]; throw err("EINVAL", p); }
  };
  return host;
}

// The vectors. Step ops: startedRaw, appPath, appWhich [bin], toolPath, cmd [bin, fresh],
// trusted [dir, fresh], ignored [bin], diag [{took|ignored: count, bin, at}],
// env {set: {...}, del: [...]}, host {files+: [...], files-: [...], links: {...}},
// clock [ms] (advances the stub clock; it stands still otherwise).
export const VECTORS = [
  {
    name: "narrowed only: a system tool comes from /usr/bin, by absolute path",
    host: { files: ["/usr/bin/xdg-open", "/home/u/.local/bin/xdg-open"] },
    env: narrowed("/home/u/.local/bin:/usr/bin"),
    steps: [
      ["cmd", ["xdg-open"], "/usr/bin/xdg-open"],
      ["ignored", ["xdg-open"], null],
      ["toolPath", [], NARROWED],
      ["appPath", [], "/home/u/.local/bin:/usr/bin:/usr/local/bin:/usr/local/sbin:/bin:/usr/sbin:/sbin:/snap/bin:/run/current-system/sw/bin:/run/current-system/profile/bin"],
      ["diag", [{ took: 0, ignored: 0, bin: "xdg-open" }]]
    ]
  },
  {
    name: "trusted store dir (NixOS wrapper): the tool is found there",
    host: { dirs: { "/nix/store/aaaa-xdg-utils-1.2": R("EROFS"), [STORE]: R("EROFS") }, files: [STORE + "/xdg-mime"] },
    env: narrowed(STORE + ":/home/u/.local/bin:/usr/bin"),
    steps: [
      ["trusted", [STORE], STORE],
      ["cmd", ["xdg-mime"], STORE + "/xdg-mime"],
      ["cmd", ["xdg-mime"], STORE + "/xdg-mime"],
      ["toolPath", [], NARROWED + ":" + STORE],
      ["diag", [{ took: 1, ignored: 0, bin: "xdg-mime", at: STORE + "/xdg-mime" }]]
    ]
  },
  {
    name: "per-user profile: a root-owned link into the store is followed to its real dir",
    host: {
      dirs: { [HM]: R("EROFS"), [HM + "/bin"]: R("EROFS") },
      links: { "/etc/profiles/per-user/u": HM },
      files: [HM + "/bin/git"]
    },
    env: narrowed("/etc/profiles/per-user/u/bin:/usr/bin"),
    steps: [
      ["trusted", ["/etc/profiles/per-user/u/bin"], HM + "/bin"],
      ["cmd", ["git"], HM + "/bin/git"],
      ["toolPath", [], NARROWED + ":" + HM + "/bin"],
      ["diag", [{ took: 1, ignored: 0, bin: "git", at: HM + "/bin/git" }]]
    ]
  },
  {
    name: "user-owned link (~/.nix-profile): not trusted, the copy there is ignored",
    host: {
      dirs: { [PROF]: R("EROFS"), [PROF + "/bin"]: R("EROFS") },
      links: { "/home/u/.nix-profile": PROF },
      linkUids: { "/home/u/.nix-profile": 1000 },
      files: [PROF + "/bin/hyprctl"]
    },
    env: narrowed("/home/u/.nix-profile/bin:/usr/bin"),
    steps: [
      ["trusted", ["/home/u/.nix-profile/bin"], null],
      ["cmd", ["hyprctl"], null],
      ["ignored", ["hyprctl"], "/home/u/.nix-profile/bin"],
      ["cmd", ["hyprctl"], null],
      ["toolPath", [], NARROWED],
      ["diag", [{ took: 0, ignored: 1, bin: "hyprctl", at: "/home/u/.nix-profile/bin" }]]
    ]
  },
  {
    name: "planted copy in ~/.local/bin, none in system dirs: missing, never the planted one",
    host: { files: ["/home/u/.local/bin/qemu-system-x86_64"] },
    env: narrowed("/home/u/.local/bin:/usr/bin"),
    steps: [
      ["cmd", ["qemu-system-x86_64"], null],
      ["ignored", ["qemu-system-x86_64"], "/home/u/.local/bin"],
      ["diag", [{ took: 0, ignored: 1, bin: "qemu-system-x86_64", at: "/home/u/.local/bin" }]]
    ]
  },
  {
    name: "writable parent: a root-owned read-only dir under a user-owned dir is not trusted",
    host: { dirs: { "/opt/mine": U(), "/opt/mine/bin": R() }, files: ["/opt/mine/bin/git"] },
    env: narrowed("/opt/mine/bin:/usr/bin"),
    steps: [
      ["trusted", ["/opt/mine/bin"], null],
      ["cmd", ["git"], null],
      ["ignored", ["git"], "/opt/mine/bin"]
    ]
  },
  {
    name: "root-owned but writable dir: not trusted",
    host: { dirs: { "/opt/shared": { uid: 0, ro: null } }, files: ["/opt/shared/git"] },
    env: narrowed("/opt/shared:/usr/bin"),
    steps: [["trusted", ["/opt/shared"], null], ["cmd", ["git"], null]]
  },
  {
    name: "RHEL qemu shim dir appended by the launcher: root-owned, trusted, found",
    host: {
      dirs: { "/usr/lib": R(), "/usr/lib/claude-desktop": R(), "/usr/lib/claude-desktop/qemu-shim": R(), "/usr/libexec": R() },
      links: { "/usr/lib/claude-desktop/qemu-shim/qemu-system-x86_64": "/usr/libexec/qemu-kvm" },
      files: ["/usr/libexec/qemu-kvm"]
    },
    env: narrowed("/usr/local/bin:/usr/bin:/bin:/usr/lib/claude-desktop/qemu-shim"),
    steps: [
      ["cmd", ["qemu-system-x86_64"], "/usr/lib/claude-desktop/qemu-shim/qemu-system-x86_64"],
      ["toolPath", [], NARROWED + ":/usr/lib/claude-desktop/qemu-shim"]
    ]
  },
  {
    name: "narrowing off (no variables): bare name from process.env.PATH, as before",
    host: { files: ["/home/u/.local/bin/git", "/usr/bin/git"] },
    env: { PATH: "/home/u/.local/bin:/usr/bin" },
    steps: [
      ["startedRaw", [], null],
      ["appPath", [], null],
      ["toolPath", [], "/home/u/.local/bin:/usr/bin"],
      ["cmd", ["git"], "git"],
      ["cmd", ["nope"], null],
      ["diag", [{ took: 0, ignored: 0, bin: "git" }]]
    ]
  },
  {
    name: "flag flip between calls: restored PATH, then narrowed again",
    host: { files: ["/home/u/.local/bin/xprop", "/usr/bin/xprop"] },
    env: narrowed("/home/u/.local/bin:/usr/bin"),
    steps: [
      ["cmd", ["xprop"], "/usr/bin/xprop"],
      ["env", { set: { PATH: "/home/u/.local/bin:/usr/bin" } }],
      ["startedRaw", [], null],
      ["cmd", ["xprop"], "xprop"],
      ["toolPath", [], "/home/u/.local/bin:/usr/bin"],
      ["env", { set: { PATH: NARROWED } }],
      ["startedRaw", [], "/home/u/.local/bin:/usr/bin"],
      ["cmd", ["xprop"], "/usr/bin/xprop"]
    ]
  },
  {
    name: "fresh: a tool installed after the first lookup is seen only with fresh",
    host: { dirs: { [HM]: R("EROFS"), [HM + "/bin"]: R("EROFS") }, links: { "/etc/profiles/per-user/u": HM } },
    env: narrowed("/etc/profiles/per-user/u/bin:/usr/bin"),
    steps: [
      ["cmd", ["wl-copy"], null],
      ["host", { "files+": [HM + "/bin/wl-copy"] }],
      ["cmd", ["wl-copy"], null],
      ["cmd", ["wl-copy", true], HM + "/bin/wl-copy"]
    ]
  },
  {
    // MISS_TTL_MS = 5000 in both copies. A hit is kept for good, also when the
    // binary goes away later: the lookup does not re-check it, the spawn fails.
    name: "a miss expires after 5 s, a hit is kept for good: an installed tool is seen without fresh or a restart",
    host: { dirs: { [HM]: R("EROFS"), [HM + "/bin"]: R("EROFS") }, links: { "/etc/profiles/per-user/u": HM } },
    env: narrowed("/etc/profiles/per-user/u/bin:/usr/bin"),
    steps: [
      ["cmd", ["ydotool"], null],
      ["cmd", ["pgrep"], null],
      ["host", { "files+": [HM + "/bin/ydotool", "/usr/bin/pgrep"] }],
      ["clock", 4999],
      ["cmd", ["ydotool"], null],
      ["cmd", ["pgrep"], null],
      ["clock", 1],
      ["cmd", ["ydotool"], HM + "/bin/ydotool"],
      ["cmd", ["pgrep"], "/usr/bin/pgrep"],
      ["host", { "files-": [HM + "/bin/ydotool", "/usr/bin/pgrep"] }],
      ["clock", 3600000],
      ["cmd", ["ydotool"], HM + "/bin/ydotool"],
      ["cmd", ["pgrep"], "/usr/bin/pgrep"],
      ["cmd", ["pgrep", true], null],
      ["cmd", ["pgrep"], null],
      ["diag", [{ took: 1, ignored: 0, bin: "ydotool", at: HM + "/bin/ydotool" }]]
    ]
  },
  {
    name: "narrowing off: a missing tool's bare name is seen 5 s after it is installed",
    host: {},
    env: { PATH: "/home/u/.local/bin:/usr/bin" },
    steps: [
      ["cmd", ["spectacle"], null],
      ["host", { "files+": ["/home/u/.local/bin/spectacle"] }],
      ["cmd", ["spectacle"], null],
      ["clock", 5000],
      ["cmd", ["spectacle"], "spectacle"]
    ]
  },
  {
    name: "fresh re-walks a link: a root link repointed into a user dir loses trust",
    host: {
      dirs: { [HM]: R("EROFS"), [HM + "/bin"]: R("EROFS"), "/home/u/evil": U(), "/home/u/evil/bin": U() },
      links: { "/etc/profiles/per-user/u": HM },
      files: [HM + "/bin/gio", "/home/u/evil/bin/gio"]
    },
    env: narrowed("/etc/profiles/per-user/u/bin:/usr/bin"),
    steps: [
      ["trusted", ["/etc/profiles/per-user/u/bin"], HM + "/bin"],
      ["host", { links: { "/etc/profiles/per-user/u": "/home/u/evil" } }],
      ["trusted", ["/etc/profiles/per-user/u/bin"], HM + "/bin"],
      ["trusted", ["/etc/profiles/per-user/u/bin", true], null],
      ["cmd", ["gio", true], null]
    ]
  },
  {
    name: "relative and duplicate started entries are skipped; narrowed dirs keep their order",
    host: { dirs: { "/opt/tools": R(), "/opt/tools/bin": R() }, files: ["/opt/tools/bin/xsel"] },
    env: narrowed("rel/bin::/usr/bin:/opt/tools/bin:/opt/tools/bin"),
    steps: [
      ["toolPath", [], NARROWED + ":/opt/tools/bin"],
      ["appPath", [], "/usr/bin:/opt/tools/bin:/usr/local/bin:/usr/local/sbin:/bin:/usr/sbin:/sbin:/snap/bin:/run/current-system/sw/bin:/run/current-system/profile/bin"],
      ["cmd", ["xsel"], "/opt/tools/bin/xsel"]
    ]
  },
  {
    name: "a copy in /usr/bin wins over a trusted started dir and over a planted one",
    host: { dirs: { [STORE.replace(/\/bin$/, "")]: R("EROFS"), [STORE]: R("EROFS") }, files: ["/usr/bin/xdg-mime", STORE + "/xdg-mime", "/home/u/.local/bin/xdg-mime"] },
    env: narrowed("/home/u/.local/bin:" + STORE + ":/usr/bin"),
    steps: [["cmd", ["xdg-mime"], "/usr/bin/xdg-mime"], ["diag", [{ took: 0, ignored: 0, bin: "xdg-mime" }]]]
  },
  {
    name: "user-owned symlink inside a root-owned read-only dir: the hop's owner makes it untrusted",
    host: {
      dirs: { [HM]: R("EROFS"), [HM + "/bin"]: R("EROFS") },
      links: { "/etc/profiles/per-user/u": HM },
      linkUids: { "/etc/profiles/per-user/u": 1000 },
      files: [HM + "/bin/git"]
    },
    env: narrowed("/etc/profiles/per-user/u/bin:/usr/bin"),
    steps: [
      ["trusted", ["/etc/profiles/per-user/u/bin"], null],
      ["cmd", ["git"], null],
      ["ignored", ["git"], "/etc/profiles/per-user/u/bin"],
      ["toolPath", [], NARROWED]
    ]
  },
  {
    name: "running as root: every W_OK check succeeds, so no started dir is trusted; narrowed dirs still work",
    host: { root: true, dirs: { "/nix/store/aaaa-xdg-utils-1.2": R(), [STORE]: R() }, files: ["/usr/bin/git", STORE + "/xdg-mime"] },
    env: narrowed(STORE + ":/usr/bin"),
    steps: [
      ["cmd", ["git"], "/usr/bin/git"],
      ["trusted", [STORE], null],
      ["cmd", ["xdg-mime"], null],
      ["toolPath", [], NARROWED]
    ]
  },
  {
    name: "a user-owned root directory (rootless container): nothing under it is trusted",
    host: { dirs: { "/": { uid: 1000, ro: null }, "/nix/store/aaaa-xdg-utils-1.2": R("EROFS"), [STORE]: R("EROFS") }, files: [STORE + "/xdg-mime"] },
    env: narrowed(STORE),
    steps: [["trusted", [STORE], null], ["cmd", ["xdg-mime"], null], ["toolPath", [], NARROWED]]
  },
  {
    name: "APP PATH lookup: the started PATH first, as the user's shell resolves it",
    host: { files: ["/home/u/.local/bin/git", "/usr/bin/git", "/usr/bin/sway"] },
    env: narrowed("rel:/home/u/.local/bin:/usr/bin"),
    steps: [
      ["appWhich", ["git"], "/home/u/.local/bin/git"],
      ["appWhich", ["sway"], "/usr/bin/sway"],
      ["appWhich", ["nope"], null],
      ["env", { set: { PATH: "/usr/bin:/home/u/.local/bin" } }],
      ["appWhich", ["git"], "/usr/bin/git"]
    ]
  },
  {
    name: "untrusted started dir before a trusted one: the trusted copy is taken",
    host: { dirs: { [STORE.replace(/\/bin$/, "")]: R("EROFS"), [STORE]: R("EROFS") }, files: [STORE + "/xdg-open", "/home/u/.local/bin/xdg-open"] },
    env: narrowed("/home/u/.local/bin:" + STORE),
    steps: [["cmd", ["xdg-open"], STORE + "/xdg-open"], ["ignored", ["xdg-open"], null]]
  }
];

// Adapters: { api, diag, env, host } for one fresh instance of a copy.
// api: startedRaw, appPath, toolPath, cmd(bin, fresh), trusted(dir, fresh),
// ignored(bin).
function sandbox(host, env) {
  const diag = [];
  const proc = { platform: "linux", env };
  // A stub clock: both copies read only Date.now() (the miss TTL).
  const clock = { t: 1000000 };
  const ctx = {
    process: proc, console: { log() {}, warn() {} }, Date: { now: () => clock.t },
    require: (id) => {
      if (id === "fs") return host.fs;
      if (id === "path") return path;
      throw new Error("unexpected require " + id);
    }
  };
  ctx.globalThis = ctx;
  ctx.__cdbDiag = (m) => diag.push(String(m));
  return { ctx, diag, proc, clock };
}

export function loadResolver(src, host, env) {
  const { ctx, diag, proc, clock } = sandbox(host, env);
  vm.runInNewContext(src, ctx);
  const t = ctx.__cdbToolPath;
  if (!t) throw new Error("js/tool_path.js did not define globalThis.__cdbToolPath");
  return {
    diag, proc, clock, raw: t,
    api: {
      startedRaw: () => t.startedPath(), appPath: () => t.appPath(), appWhich: (b) => t.appWhich(b), toolPath: () => t.toolPath(),
      cmd: (b, f) => t.cmd(b, f), trusted: (d, f) => t.trusted(d, f), ignored: (b) => t.ignored(b)
    }
  };
}

// The executor's helper section, spliced out of js/cu_linux_executor.js.
export function executorSection(src) {
  const a = src.indexOf("function _startedRaw(){");
  const b = src.indexOf("function _envFor(kind){");
  if (a < 0 || b < a) throw new Error("executor PATH helper section not found");
  return src.slice(a, b);
}
export function loadExecutorCopy(src, host, env) {
  const { ctx, diag, proc, clock } = sandbox(host, env);
  const body = "var _fs=require('fs'),_path=require('path');\n" + executorSection(src) +
    "\nglobalThis.__x={startedRaw:_startedRaw,appPath:_startedPath,appWhich:function(b){return _walk(_lookupPath().split(':'),b)},toolPath:_toolPath,cmd:_toolCmd,trusted:_dirTrusted,ignored:function(b){return Object.prototype.hasOwnProperty.call(_toolIgn,b)?_toolIgn[b]:null}};";
  vm.runInNewContext(body, ctx);
  return { diag, proc, clock, api: ctx.__x };
}

// Runs one vector against a loader; returns [{label, ok, got, want}].
export function runVector(v, load, src) {
  const host = makeHost(v.host);
  const env = { ...v.env };
  const inst = load(src, host, env);
  const out = [];
  v.steps.forEach((st, i) => {
    const [op, args, want] = st;
    if (op === "clock") { inst.clock.t += args; return; }
    if (op === "env") { Object.assign(inst.proc.env, args.set || {}); (args.del || []).forEach((k) => delete inst.proc.env[k]); return; }
    if (op === "host") {
      (args["files+"] || []).forEach((f) => host.files.add(f));
      (args["files-"] || []).forEach((f) => host.files.delete(f));
      Object.assign(host.links, args.links || {});
      return;
    }
    if (op === "diag") {
      const d = args[0];
      const took = inst.diag.filter((l) => l.includes(" " + d.bin + " -> "));
      const ign = inst.diag.filter((l) => l.includes(d.bin + " found only in "));
      const okAt = d.at === undefined || [...took, ...ign].every((l) => l.includes(d.at));
      out.push({ label: `#${i} diag ${d.bin}: took=${d.took} ignored=${d.ignored}`, ok: took.length === d.took && ign.length === d.ignored && okAt, got: JSON.stringify(inst.diag), want: JSON.stringify(d) });
      return;
    }
    let got;
    try { got = inst.api[op](...args); } catch (e) { got = "THREW " + e.message; }
    out.push({ label: `#${i} ${op}(${args.map((a) => JSON.stringify(a)).join(",")})`, ok: got === want, got, want });
  });
  return out;
}
