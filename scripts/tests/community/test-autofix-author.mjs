#!/usr/bin/env node
// Audited 4.16336.0 eligibility helper and model activation method. These small
// fixtures preserve upstream's control flow, including the awaits/race guard.
// When tmp/app.asar.contents is available, repeat against the pristine release.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = join(ROOT, "patches/community/add_feature_autofix_author");
const dir = mkdtempSync(join(tmpdir(), "cdb-autofix-author-"));
const fixture = `function ld(e,t){let n=e.user?.login;return!!t&&!!n&&n.toLowerCase()===t.toLowerCase()}
function dd(e,t,n,r,i,a){if(!e?.success)return"unreadable";if(t.login===null)return t.failed?"unreadable":"no_login";if(!ld({user:{login:e.author}},t.login))return"not_author";let o=Date.parse(e.createdAt??"");return a!==void 0&&!(o>=a&&o<=i+Fd)?"older_pr":n.length===0?"no_origin":n.some((t=>{let n=\`\${t.owner}/\${t.name}\`.toLowerCase();return t.hostname===Wu(r)&&(n===r.repo.toLowerCase()||n===e.headRepo?.toLowerCase())}))?"armed":"other_repo"}
class Manager {async armOwnCreate(){} async enableAutoFixForModel(e,t,n,r){if(this.storedAutoFix(e,t,n,r)===!0)return;if(this.config.claudeCodeRunsHere?.(e)!==!0)return"runs_elsewhere";let i=this.autoFixRefusedToModel(e,t,n,r);if(i!==void 0)return i;let a=this.storedAutoFix(e,t,n,r),o=Wu({host:r}),s=Ku(e,{host:r,repo:t,prNumber:n}),c=this.autoFixWrites.get(s),l=await this.readGhLogin(o).catch((()=>({login:null,failed:!0})));if(l.login===null)return l.failed?"unreadable":"no_login";this.prStateCache.delete(Gu(o,t,n));let u=await this.getPrStateByNumber(t,n,r).catch((()=>void 0));if(!u?.success)return"unreadable";if(!ld({user:{login:u.author}},l.login))return"not_author";let d=this.autoFixRefusedToModel(e,t,n,r);if(d!==void 0)return d;let f=this.storedAutoFix(e,t,n,r);if(f!==a||this.autoFixWrites.get(s)!==c)return f?void 0:"changed";this.writeBoundPrAutoFix(e,t,n,!0,"model",r)}
async getPrStateByNumberUncached(e,n,r,i={}){let o=(await this.ghRest.rest(e,r)).data;return{success:!0,ownCreate:await this.getGhLogin(r).then((e=>e===null?void 0:ld(o,e))),author:o.user?.login}}
async getPrStateForBranchUncached(e,r,i,a=[]){let n=await this.resolveSlug(e),c=await this.ghRest.rest(r,n.hostname),l=c.data.length>0?await this.getGhLogin(n.hostname):null,u=new Set(a),d=await Promise.all(c.data.map((async e=>ld(e,l)||e.number!==void 0&&u.has(e.number)||fd(e,n.hostname)?!0:await this.authorMayPush(n,e)))),h=c.data.filter(((e,t)=>d[t]))[0];return await this.withMergeQueueState({success:!0,number:h.number,ownCreate:l===null?void 0:ld(h,l)})}
async discoverPrByHeadSha(e,n){let t=await this.resolveSlug(e),s="org/repo",o=await this.ghRest.rest(n,t.hostname),c=o.data.length>0?await this.getGhLogin(t.hostname):null,l=c?.toLowerCase(),u=o.data,d=await Promise.all(u.map((async e=>{let n=ld(e,c);return e.head?.repo?.full_name?.toLowerCase()===s?n||fd(e,t.hostname)||await this.authorMayPush(t,e):n&&e.head?.repo?.owner?.login?.toLowerCase()===l}))),p=u.filter(((e,t)=>d[t]))[0];return{success:!0,number:p.number,ownCreate:c!==null&&!ld(p,c)?!1:void 0}}}`;
function patch(source, name = "fixture.js") {
  const path = join(dir, name);
  writeFileSync(path, source);
  execFileSync(bin, [path], { stdio: "pipe" });
  const result = readFileSync(path, "utf8");
  assert.equal(result.replace(/!\(globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.author,[\w$]+(?:\.host)?\?\?"github\.com"\)===true\)&&/g, "")
    .replace(/&&!\(globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.user\?\.login,[\w$]+\.hostname\)===true\)/g, "")
    .replace(/\|\|globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.user\?\.login,[\w$]+(?:\.hostname|\?\?"github\.com")\)===true/g, ""), source,
    "the patch changes only the author comparison conditions");
  execFileSync(bin, [path], { stdio: "pipe" });
  assert.equal(readFileSync(path, "utf8"), result, "patch is byte-idempotent");
  execFileSync(process.execPath, ["--check", path]);
  return result;
}
function loadSettings(profile = dir, platform = "linux") {
  const handlers = {};
  const require = createRequire(import.meta.url);
  const electron = {
    app: { getPath: () => profile, on() {}, once() {} },
    ipcMain: { handle: (ch, f) => { handlers[ch] = f; }, removeHandler() {} },
    shell: {}
  };
  const ctx = vm.createContext({ require: m => m === "electron" ? electron : require(m),
    process: { platform, env: {} }, console, setTimeout, clearTimeout, URL });
  // The core patch emits the shared IPC sender guard ahead of the module.
  vm.runInContext(readFileSync(join(ROOT, "js/sender_guard.js"), "utf8"), ctx);
  vm.runInContext(readFileSync(join(ROOT, "js/extra_settings_main.js"), "utf8"), ctx);
  return { ctx, handlers };
}
const sender = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
try {
  const { ctx, handlers } = loadSettings();
  const read = () => handlers["cdb-autofix-author:read"](sender);
  const set = value => handlers["cdb-autofix-author:set"](sender, value);
  const key = "autoFixTrustedAuthors";
  const pair = "github.com/project-app[bot]";
  const allowed = (login = "project-app[bot]", host = "github.com") => ctx.__cdbAutoFixAuthorAllowed(login, host);
  const json = join(dir, "claude-desktop-extra.json"), jsonc = join(dir, "claude-desktop-extra.jsonc");
  assert.equal(allowed(), false);
  assert.equal((await read()).entries.length, 0);
  writeFileSync(json, '{"activeTheme":"nord","autoFixAllowDifferentAuthor":true}');
  assert.equal(allowed(), false, "legacy bypass never becomes implicit trust");
  assert.equal((await set([" GITHUB.COM/Project-App[bot] ", pair, "ghe.example/human"])).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(json)), { activeTheme: "nord", [key]: [pair, "ghe.example/human"] });
  assert.equal(allowed(), true);
  assert.equal(allowed("PROJECT-APP[bot]", "GITHUB.COM"), true);
  assert.equal(allowed("other-app[bot]"), false);
  assert.equal(allowed("project-app[bot]", "ghe.example"), false, "same login on another server is not trusted");
  assert.equal(allowed("human", "ghe.example"), true, "explicit enterprise identity works");
  assert.equal(allowed("human", "github.com"), false);
  assert.equal(loadSettings().ctx.__cdbAutoFixAuthorAllowed("project-app[bot]", "github.com"), true, "persists across restart");
  assert.equal(loadSettings(join(dir, "other-profile")).ctx.__cdbAutoFixAuthorAllowed("project-app[bot]", "github.com"), false);
  for (const invalid of [true, null, {}, "github.com/user", [1], ["*/*"], ["github.com/*"],
    ["https://github.com/user"], ["github.com:443/user"], ["github.com/user/repo"], [".github.com/user"],
    ["github.com/user@example.com"], ["github.com/user name"], Array(51).fill(pair), [pair, "broken"]]) {
    assert.equal((await set(invalid)).ok, false, "malformed or oversized list rejected atomically: " + JSON.stringify(invalid));
    assert.equal(allowed(), true, "rejected save does not modify existing trust");
  }
  writeFileSync(jsonc, `{// human override\n"${key}":[],}`);
  assert.equal(allowed(), false, "empty JSONC list overrides populated JSON");
  assert.equal((await read()).lockedByJsonc, true);
  assert.equal((await set([pair])).ok, false);
  writeFileSync(jsonc, JSON.stringify({ [key]: [pair] }));
  assert.equal(allowed(), true);
  assert.equal((await set([])).ok, false);
  writeFileSync(jsonc, JSON.stringify({ [key]: [pair, "invalid"] }));
  assert.equal(allowed(), false, "invalid JSONC list denies all, not a partial allowlist or JSON fallback");
  assert.equal((await read()).lockedByJsonc, true);
  assert.ok((await read()).warning);
  writeFileSync(jsonc, "broken JSONC");
  assert.equal(allowed(), false, "unreadable human override cannot fall back to permissive JSON");
  assert.equal((await set([pair])).ok, false);
  rmSync(jsonc);
  assert.equal((await set([])).ok, true);
  assert.equal(allowed(), false, "revocation applies live");
  assert.deepEqual(JSON.parse(readFileSync(json)), { activeTheme: "nord" });
  for (const value of [true, "true", 1, {}, null, false, [pair, "invalid"]]) {
    writeFileSync(json, JSON.stringify({ [key]: value }));
    assert.equal(allowed(), false, "invalid config denies all");
  }
  writeFileSync(json, "broken JSON");
  assert.equal(allowed(), false);
  assert.equal((await set([pair])).ok, false, "do not overwrite malformed config");
  const hostile = { ...sender, sender: { ...sender.sender, getURL: () => "https://claude.ai.evil.test/settings" } };
  assert.equal((await handlers["cdb-autofix-author:set"](hostile, [pair])).ok, false);
  assert.equal((await handlers["cdb-autofix-author:set"]({ ...sender, senderFrame: { parent: {} } }, [pair])).ok, false);
  const win = loadSettings(dir, "win32");
  assert.equal(win.ctx.__cdbAutoFixAuthorAllowed, undefined);
  assert.equal((await win.handlers["cdb-autofix-author:set"](sender, [pair])).ok, false);
  console.log("PASS settings: exact host/login allowlist, defaults, persistence, legacy bypass ignored, validation, JSONC lock, sender guards");

  // Ownership/discovery sites: extract each patched expression from the patched
  // source (names recovered, not assumed) and evaluate it with stubs.
  async function checkOwnership(patched, label) {
    const A = String.raw`globalThis\.__cdbAutoFixAuthorAllowed\?\.\(`;
    const one = re => { const all = [...patched.matchAll(new RegExp(re, "g"))]; assert.equal(all.length, 1, label + ": exactly one " + re); return all[0]; };
    const m1 = one(String.raw`ownCreate:(await this\.getGhLogin\(([\w$]+)\)\.then\(\(([\w$]+)=>\3===null\?void 0:[\w$]+\(([\w$]+),\3\)\|\|${A}\4\.user\?\.login,\2\?\?"github\.com"\)===true\)\))`);
    const m2 = one(String.raw`\(async ([\w$]+)=>([\w$]+\(\1,([\w$]+)\)\|\|\1\.number!==void 0&&([\w$]+)\.has\(\1\.number\)\|\|([\w$]+)\(\1,([\w$]+)\.hostname\)\|\|${A}\1\.user\?\.login,\6\.hostname\)===true\?!0:await this\.authorMayPush\(\6,\1\))\)`);
    const m3 = one(String.raw`ownCreate:(([\w$]+)===null\?void 0:[\w$]+\(([\w$]+),\2\)\|\|${A}\3\.user\?\.login,([\w$]+)\.hostname\)===true)\}\)`);
    const m4 = one(String.raw`\(async ([\w$]+)=>(\{let ([\w$]+)=[\w$]+\(\1,([\w$]+)\);return \1\.head\?\.repo\?\.full_name\?\.toLowerCase\(\)===([\w$]+)\?\3\|\|([\w$]+)\(\1,([\w$]+)\.hostname\)\|\|${A}\1\.user\?\.login,\7\.hostname\)===true\|\|await this\.authorMayPush\(\7,\1\):\3&&\1\.head\?\.repo\?\.owner\?\.login\?\.toLowerCase\(\)===([\w$]+)\})\)`);
    const m5 = one(String.raw`ownCreate:(([\w$]+)!==null&&![\w$]+\(([\w$]+),\2\)&&!\(${A}\3\.user\?\.login,([\w$]+)\.hostname\)===true\)\?!1:void 0)\}`);
    const matcher = one(String.raw`function ([\w$]+)\([\w$]+,[\w$]+\)\{let [\w$]+=[\w$]+\.user\?\.login;return[^}]*\}`);
    const ctx = vm.createContext({});
    vm.runInContext(matcher[0], ctx);
    const fn = (params, body) => vm.runInContext(`(async function(${params.join(",")})${body})`, ctx);
    const s1 = fn([m1[2], m1[4]], `{return ${m1[1]}}`);
    const s2 = fn([m2[1], m2[3], m2[4], m2[6], m2[5]], `{return ${m2[2]}}`);
    const s3 = fn([m3[2], m3[3], m3[4]], `{return ${m3[1]}}`);
    const s4 = fn([m4[1], m4[4], m4[5], m4[6], m4[7], m4[8]], m4[2]);
    const s5 = fn([m5[2], m5[3], m5[4]], `{return ${m5[1]}}`);
    const pr = (login, fullName = "org/repo") => ({ number: 7, user: { login, type: "Bot" }, head: { repo: { full_name: fullName, owner: { login: fullName.split("/")[0] } } } });
    const bot = pr("project-app[bot]"), other = pr("other-app[bot]"), mine = pr("Human");
    const gh = { hostname: "github.com" }, ghe = { hostname: "ghe.example" };
    const self = login => ({ getGhLogin: async () => login, authorMayPush: async () => false });
    const byNumber = (p, host = "github.com", login = "human") => s1.call(self(login), host, p);
    const branch = (p, h = gh, login = "human") => s3.call(self(login), login, p, h);
    const sha = (p, h = gh, login = "human") => s5.call(self(login), login, p, h);
    const discover = (p, h = gh, login = "human") => s2.call(self(login), p, login, new Set(), h, () => false);
    const discoverSha = (p, h = gh, login = "human") => s4.call(self(login), p, login, "org/repo", () => false, h, login?.toLowerCase());
    const all = (p, h, login) => Promise.all([byNumber(p, h === ghe ? "ghe.example" : "github.com", login), discover(p, h, login), branch(p, h, login), discoverSha(p, h, login), sha(p, h, login)]);
    assert.deepEqual(await all(bot, gh), [false, false, false, false, false], "missing helper keeps upstream ownership");
    ctx.__cdbAutoFixAuthorAllowed = (login, host) => typeof login === "string" && login.toLowerCase() === "project-app[bot]" && host === "github.com";
    assert.deepEqual(await all(bot, gh), [true, true, true, true, undefined], "listed author on its host is own / discovered");
    assert.equal(await byNumber(bot, undefined), true, "omitted by-number host defaults to github.com");
    assert.deepEqual(await all(other, gh), [false, false, false, false, false], "unlisted author stays not-own");
    assert.deepEqual(await all(bot, ghe), [false, false, false, false, false], "listed login on another server is not trusted");
    assert.deepEqual(await all(mine, gh), [true, true, true, true, undefined], "the gh user's own PR is unchanged");
    assert.deepEqual([await byNumber(bot, "github.com", null), await branch(bot, gh, null), await sha(bot, gh, null)], [undefined, undefined, undefined], "no login read stays unknown");
    assert.equal(await discoverSha(pr("project-app[bot]", "fork/repo")), false, "fork PRs still need the user's own fork");
  }
  // Free constants the extracted upstream code references (renamed on every
  // re-minify): on a ReferenceError, define the name from its `X=<literal>`
  // definition in the real chunk (`realChunk`), then retry. Never hardcoded.
  let realChunk = null;
  function defineFree(ctx, err) {
    const name = /^([\w$]+) is not defined$/.exec(err?.message || "")?.[1];
    if (!name || !realChunk || name in ctx) throw err;
    const esc = name.replace(/\$/g, "\\$");
    const defs = [...realChunk.matchAll(new RegExp(`(?:^|[,;{}\\s])${esc}=(\\d[\\w.+]*|new Map|new Set|"[^"]*"|/[^/\\n]+/[a-z]*)(?=[,;}])`, "g"))].map(x => x[1]);
    // 1-char names are chunk-local or imports (ambiguous across scopes): never take a literal for those.
    if (defs.length && name.length > 1) { vm.runInContext(`globalThis[${JSON.stringify(name)}]=(${defs[0]})`, ctx); return; }
    // A helper function: lift its source (brace-balanced) from the real bundle.
    const fm = new RegExp(`function ${esc}\\([^)]*\\)\\{`).exec(realChunk);
    if (fm) {
      let depth = 1, i = fm.index + fm[0].length;
      for (; i < realChunk.length && depth; i++) depth += realChunk[i] === "{" ? 1 : realChunk[i] === "}" ? -1 : 0;
      vm.runInContext(realChunk.slice(fm.index, i), ctx);
      return;
    }
    // Otherwise an imported namespace (`G=require("./index.chunk-...")`): identity stubs, except
    // the PR-open predicate the module exports as `.n` (open and not dismissed).
    vm.runInContext(`globalThis[${JSON.stringify(name)}]=new Proxy({}, {get:(_, k)=>k==="n"?(p=>p.state==="OPEN"&&!p.dismissed):(x=>x)})`, ctx);
  }
  const heal = (ctx, fn) => {
    for (let i = 0; i < 20; i++) {
      try { return fn(); } catch (e) { defineFree(ctx, e); }
    }
    throw new Error("too many free constants");
  };
  const healAsync = async (ctx, fn) => {
    for (let i = 0; i < 20; i++) {
      try { return await fn(); } catch (e) { defineFree(ctx, e); }
    }
    throw new Error("too many free constants");
  };
  async function exercise(source, label, armSource, judgeName = "dd") {
    const patched = patch(source, label + ".js");
    await checkOwnership(patched, label);
    let enabled = false;
    // The fixture needs its stubs; the real release resolves its free names from the bundle.
    const ctx = vm.createContext(realChunk ? {} : { Fd: 300000, Md: 600000,
      t: { jJ() {}, pa: () => false }, K: { n: p => p.state === "OPEN" && !p.dismissed },
      ad: (a, b) => a.repo === b.repo && a.prNumber === b.prNumber,
      Wu: r => r.host || "github.com", Ku: () => "key", Gu: () => "key" });
    vm.runInContext(patched + ";globalThis.Manager=Manager;globalThis.judge=" + judgeName + ";", ctx);
    const pr = { success: true, author: "project-app[bot]", createdAt: new Date().toISOString() };
    const login = { login: "human", failed: false };
    const origins = [{ hostname: "github.com", owner: "org", name: "repo" }];
    const binding = { host: "github.com", repo: "org/repo" };
    const judge = (p = pr, l = login, o = origins, b = binding) => heal(ctx, () => ctx.judge(p, l, o, b, Date.now(), Date.now() - 60000));
    assert.equal(judge(), "not_author", "missing helper remains safe");
    ctx.__cdbAutoFixAuthorAllowed = (author, host) => enabled && author.toLowerCase() === "project-app[bot]" && host.toLowerCase() === "github.com";
    assert.equal(judge(), "not_author");
    assert.equal(judge({ ...pr, author: "HUMAN" }), "armed");
    enabled = true;
    assert.equal(judge(), "armed", "only listed GitHub App author is allowed");
    assert.equal(judge(pr, login, origins, { repo: binding.repo }), "armed", "omitted host defaults to github.com");
    assert.equal(judge({ ...pr, author: "other-app[bot]" }), "not_author");
    assert.equal(judge({ ...pr, author: "" }), "not_author");
    assert.equal(judge(pr, login, [{ ...origins[0], hostname: "ghe.example" }], { ...binding, host: "ghe.example" }), "not_author");
    assert.equal(judge(pr, { login: null, failed: false }), "no_login");
    assert.equal(judge(pr, { login: null, failed: true }), "unreadable");
    assert.equal(judge({ success: false }), "unreadable");
    assert.equal(judge({ ...pr, createdAt: "2000-01-01" }), "older_pr");
    assert.equal(judge(pr, login, []), "no_origin");
    assert.equal(judge(pr, login, origins, { ...binding, repo: "other/repo" }), "other_repo");
    assert.equal(judge(pr, login, origins, { ...binding, host: "other.host" }), "not_author");
    assert.equal(judge({ ...pr, author: "human" }, login, origins, { ...binding, host: "other.host" }), "other_repo");
    enabled = false;
    assert.equal(judge(), "not_author", "disabling takes effect immediately");
    enabled = true;
    let refusal, state, writes, concurrent;
    const m = new ctx.Manager();
    m.config = { claudeCodeRunsHere: () => true };
    let writeSeen = false; m.autoFixWrites = Object.assign(new Map(), { get: () => (writeSeen ? 1 : undefined) }); m.prStateCache = new Map();
    m.storedAutoFix = () => state;
    m.autoFixRefusedToModel = () => refusal;
    m.readGhLogin = async () => login;
    m.getPrStateByNumber = async () => { if (concurrent) concurrent(); return pr; };
    m.writeBoundPrAutoFix = (...args) => { writes.push(args); };
    async function run(expected) {
      writes = [];
      assert.equal(await healAsync(ctx, () => m.enableAutoFixForModel("session", "org/repo", 42, "github.com")), expected);
      assert.equal(writes.length, expected === undefined ? 1 : 0);
      if (writes.length) assert.deepEqual(writes[0], ["session", "org/repo", 42, true, "model", "github.com"]);
    }
    enabled = false; await run("not_author");
    enabled = true; await run(undefined);
    pr.author = "unlisted-app[bot]"; await run("not_author");
    pr.author = "project-app[bot]";
    writes = [];
    assert.equal(await m.enableAutoFixForModel("session", "org/repo", 42, "ghe.example"), "not_author");
    assert.equal(writes.length, 0, "model path scopes additional trust to the actual PR host");
    for (const reason of ["not_own", "unconfirmed"]) { refusal = reason; await run(reason); }
    refusal = undefined;
    m.config.claudeCodeRunsHere = () => false; await run("runs_elsewhere");
    m.config.claudeCodeRunsHere = () => true;
    m.readGhLogin = async () => ({ login: null, failed: false }); await run("no_login");
    m.readGhLogin = async () => { throw Error("unreadable"); }; await run("unreadable");
    m.readGhLogin = async () => login;
    concurrent = () => { refusal = "not_own"; }; await run("not_own"); refusal = undefined;
    concurrent = () => { writeSeen = true; }; await run("changed"); writeSeen = false;
    concurrent = () => { state = false; }; await run("changed"); state = undefined;
    concurrent = () => { enabled = false; }; await run("not_author");
    if (armSource) {
      // Execute the release's actual automatic-activation method, not a rewrite.
      let held, session, count, duringRead;
      m.config = { getSession: () => session, listSessionIds: () => ["session"] };
      m.readGhLogin = async () => login;
      m.getPrStateByNumber = async () => { duringRead?.(); return pr; };
      m.changeKeyFor = () => "key";
      m.setBoundPrAutoFix = () => { count++; held.autoFix = true; };
      async function arm(expected, change = () => {}, whileReading) {
        held = { ...binding, prNumber: 42, branch: "feature", own: true, state: "OPEN" };
        session = { prs: [held], autoFixOwnPrs: true, autoFixOwnPrsOrigin: origins[0] };
        count = 0; duringRead = whileReading; change();
        await healAsync(ctx, () => m.armOwnCreate("session", held));
        assert.equal(count, expected);
      }
      enabled = false; await arm(0);
      enabled = true; await arm(1);
      await arm(0, () => { held.own = false; });
      await arm(0, () => { held.unconfirmed = 123; });
      await arm(0, () => { held.state = "CLOSED"; });
      await arm(0, () => { held.dismissed = true; });
      await arm(0, () => { session.autoFixOwnPrs = false; });
      await arm(0, undefined, () => { held.autoFix = false; });
      await arm(0, undefined, () => { session.autoFixOwnPrs = false; });
      await arm(0, undefined, () => { enabled = false; });
    }
    console.log(`PASS ${label}: automatic eligibility, model activation, ownership/discovery, auth/scope/race rejection`);
  }
  await exercise(fixture, "fixture");
  for (const bad of [fixture.replace('return"not_author";', 'return"changed";'), fixture + fixture,
    fixture.replace("?!1:void 0", "?!1:null"), fixture.replace("fd(e,n.hostname)?!0:", "fd(e,n.host)?!0:"),
    fixture.replace(":ld(h,l)})", ":ld(l,h)})"), fixture.replace(".then((e=>e===null?", ".then((e=>e==null?")]) {
    const path = join(dir, "bad.js"); writeFileSync(path, bad);
    assert.notEqual(spawnSync(bin, [path]).status, 0, "missing/extra guard must fail loudly");
    assert.equal(readFileSync(path, "utf8"), bad, "no partially written patch");
  }
  const build = join(ROOT, "tmp/app.asar.contents/.vite/build");
  if (existsSync(build)) {
    const chunk = readdirSync(build).filter(n => /^index.*\.js$/.test(n)).map(n => readFileSync(join(build, n), "utf8")).find(s => s.includes("async enableAutoFixForModel("));
    assert.ok(chunk, "real manager chunk found");
    // Splice precisely the audited methods, not the module's imports/startup.
    const helper = chunk.match(/function [\w$]+\(e,t,n,r,i,a\)\{if\(!e\?\.success\)return"unreadable";[\s\S]*?\?"armed":"other_repo"\}/)?.[0];
    const method = chunk.match(/async enableAutoFixForModel\([^]*?\}storedAutoFix\(/)?.[0].replace(/storedAutoFix\($/, "");
    assert.ok(helper && method, "real methods retain audited shapes");
    // Names are deliberately recovered from the release, not assumed stable.
    const matchFn = helper.match(/if\(!([\w$]+)\(\{user:/)[1];
    const judgeFn = helper.match(/^function ([\w$]+)/)[1];
    const match = chunk.match(new RegExp(`function ${matchFn}\\(e,t\\)\\{[^}]+\\}`))[0];
    const arm = chunk.match(/async armOwnCreate\([^]*?\}async asGitHubNamesThem\(/)?.[0].replace(/async asGitHubNamesThem\($/, "");
    assert.ok(arm, "real automatic activation method retains its audited shape");
    // The ownership reads: by number, then by branch + head SHA (adjacent methods).
    const byNumber = chunk.match(/async getPrStateByNumberUncached\([^]*?\}(?=mergeQueueAwareTtl\()/)?.[0];
    const discovery = chunk.match(/async getPrStateForBranchUncached\([^]*?\}(?=prCacheKey\()/)?.[0];
    assert.ok(byNumber && discovery?.includes("async discoverPrByHeadSha("), "real ownership methods retain their audited shapes");
    realChunk = chunk;
    await exercise(`${match}\n${helper}\nclass Manager {${arm} ${method} ${byNumber} ${discovery}}`.replaceAll(matchFn + "(", "__cdbMatch(").replaceAll(judgeFn + "(", "__cdbJudge("), "real-release", arm, "__cdbJudge");
  } else console.log("SKIP pristine release check: tmp/app.asar.contents unavailable");
  console.log("PASS Auto-fix author opt-in");
} finally { rmSync(dir, { recursive: true, force: true }); }
