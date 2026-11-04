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
class Manager {async armOwnCreate(){} async enableAutoFixForModel(e,t,n,r){if(this.storedAutoFix(e,t,n,r)===!0)return;if(this.config.claudeCodeRunsHere?.(e)!==!0)return"runs_elsewhere";let i=this.autoFixRefusedToModel(e,t,n,r);if(i!==void 0)return i;let a=this.storedAutoFix(e,t,n,r),o=Wu({host:r}),s=Ku(e,{host:r,repo:t,prNumber:n}),c=this.autoFixWrites.get(s),l=await this.readGhLogin(o).catch((()=>({login:null,failed:!0})));if(l.login===null)return l.failed?"unreadable":"no_login";this.prStateCache.delete(Gu(o,t,n));let u=await this.getPrStateByNumber(t,n,r).catch((()=>void 0));if(!u?.success)return"unreadable";if(!ld({user:{login:u.author}},l.login))return"not_author";let d=this.autoFixRefusedToModel(e,t,n,r);if(d!==void 0)return d;let f=this.storedAutoFix(e,t,n,r);if(f!==a||this.autoFixWrites.get(s)!==c)return f?void 0:"changed";this.writeBoundPrAutoFix(e,t,n,!0,"model",r)}}`;
function patch(source, name = "fixture.js") {
  const path = join(dir, name);
  writeFileSync(path, source);
  execFileSync(bin, [path], { stdio: "pipe" });
  const result = readFileSync(path, "utf8");
  assert.equal(result.replace(/!\(globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.author,[\w$]+(?:\.host)?\?\?"github\.com"\)===true\)&&/g, ""), source,
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

  async function exercise(source, label, armSource) {
    const patched = patch(source, label + ".js");
    let enabled = false;
    const ctx = vm.createContext({ Fd: 300000, Md: 600000,
      t: { jJ() {}, pa: () => false }, K: { n: p => p.state === "OPEN" && !p.dismissed },
      ad: (a, b) => a.repo === b.repo && a.prNumber === b.prNumber,
      Wu: r => r.host || "github.com", Ku: () => "key", Gu: () => "key" });
    vm.runInContext(patched + ";globalThis.Manager=Manager;globalThis.judge=dd;", ctx);
    const pr = { success: true, author: "project-app[bot]", createdAt: new Date().toISOString() };
    const login = { login: "human", failed: false };
    const origins = [{ hostname: "github.com", owner: "org", name: "repo" }];
    const binding = { host: "github.com", repo: "org/repo" };
    const judge = (p = pr, l = login, o = origins, b = binding) => ctx.judge(p, l, o, b, Date.now(), Date.now() - 60000);
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
    m.autoFixWrites = new Map(); m.prStateCache = new Map();
    m.storedAutoFix = () => state;
    m.autoFixRefusedToModel = () => refusal;
    m.readGhLogin = async () => login;
    m.getPrStateByNumber = async () => { if (concurrent) concurrent(); return pr; };
    m.writeBoundPrAutoFix = (...args) => { writes.push(args); };
    async function run(expected) {
      writes = [];
      assert.equal(await m.enableAutoFixForModel("session", "org/repo", 42, "github.com"), expected);
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
    concurrent = () => { m.autoFixWrites.set("key", 1); }; await run("changed");
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
        await m.armOwnCreate("session", held);
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
    console.log(`PASS ${label}: automatic eligibility, model activation, auth/scope/ownership/race rejection`);
  }
  await exercise(fixture, "fixture");
  for (const bad of [fixture.replace('return"not_author";', 'return"changed";'), fixture + fixture]) {
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
    await exercise(`${match}\n${helper}\nclass Manager {${arm} ${method}}`.replaceAll(matchFn + "(", "ld(").replaceAll(judgeFn + "(", "dd("), "real-release", arm);
  } else console.log("SKIP pristine release check: tmp/app.asar.contents unavailable");
  console.log("PASS Auto-fix author opt-in");
} finally { rmSync(dir, { recursive: true, force: true }); }
