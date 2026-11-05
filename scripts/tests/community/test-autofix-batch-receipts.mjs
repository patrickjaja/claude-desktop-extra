#!/usr/bin/env node
// Sub-patch D of patches/community/add_feature_autofix_merge_ready: completion
// receipts for notices consumed later in a batched turn, only while the
// autoFixMergeReady switch is on (Linux). When tmp/app.asar.contents is
// available, repeat the rewrite against the pristine release chunks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binary = path.join(root, 'patches/community/add_feature_autofix_merge_ready');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-batch-receipts-'));
const file = path.join(temporary, 'fixture.js');
// Sub-patches A-C need their anchors too; the emitter is upstream's 4.16336.0 shape.
const EMITTER = 'finish(c$,i$,e$,s$,p$,a$){c$&&i$.query===e$.queryObj&&s$!==void 0&&!s$.adoptedByStartedCommand&&p$.health==="healthy"&&this.deps.emit("turnCompleted",a$,s$.userMessageUuid)}';
const fixture = 'class Engine{constructor(deps){this.deps=deps}async checkSession(s,p){return true}handleTurnCompleted(s,m){try{}catch{}}handleSendsDroppedUnsent(s,m,r){try{}catch{}}' + EMITTER + '}';
let passed = 0;
function patch(text) {
  if (!fs.existsSync(binary)) throw new Error(`binary missing: ${binary} (run make in patches/)`);
  fs.writeFileSync(file, text); const run = spawnSync(binary, [file], { encoding: 'utf8' });
  return { ...run, stderr: run.stderr ?? 'binary missing', text: fs.readFileSync(file, 'utf8') };
}
// ABSENT: no predicate defined at all (a destructuring default would turn undefined into true).
const ABSENT = Symbol('absent');
const load = (text, platform, enabled) => {
  const context = { process: { platform } };
  context.globalThis = context;
  if (enabled !== ABSENT) context.__cdbAutoFixMergeReadyEnabled = () => enabled;
  return vm.runInNewContext(`${text};Engine`, context);
};
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
try {
  const result = patch(fixture); assert.equal(result.status, 0, result.stderr);
  const E = load(result.text, 'linux', true);
  function run(options = {}) {
    const { ids = ['post'], pending = [], next, buffered = ids, withdrawn = [], primary = 'first', health = 'healthy', adopted = false, current = true, main = true, platform = 'linux', cycleMissing = false, aliasesMissing = false } = options;
    const enabled = 'enabled' in options ? options.enabled : true; // an explicit undefined stays undefined
    const events = [], query = {}, session = { query, pendingEchoUuids: new Map(pending.map(id => [id, 1])), nextCycleUuid: next,
      messageBuffer: buffered.map(id => ({ type: 'user', uuid: id, isWithdrawn: withdrawn.includes(id) })) };
    const Type = platform === 'linux' && enabled === true ? E : load(result.text, platform, enabled);
    new Type({ emit: (...args) => events.push(args) }).finish(main, session, { queryObj: current ? query : {} }, cycleMissing ? undefined : { userMessageUuid: primary, ...(aliasesMissing ? {} : { promptUuids: ids }), adoptedByStartedCommand: adopted }, { health }, 'owner');
    return events.map(([, , id]) => id);
  }
  test('one primary message preserves ordinary completion', () => assert.deepEqual(run({ ids: [] }), ['first']));
  test('echoed second notice receives completion too', () => assert.deepEqual(run(), ['first', 'post']));
  test('all echoed members of a mixed machine/human batch complete', () => assert.deepEqual(run({ ids: ['human', 'ready', 'post'] }), ['first', 'human', 'ready', 'post']));
  test('duplicate and primary aliases complete only once', () => assert.deepEqual(run({ ids: ['first', 'post', 'post'] }), ['first', 'post']));
  test('unread pending messages are not confirmed', () => assert.deepEqual(run({ ids: ['post', 'future'], pending: ['future'] }), ['first', 'post']));
  test('next-cycle message is not confirmed', () => assert.deepEqual(run({ ids: ['post', 'future'], next: 'future' }), ['first', 'post']));
  test('withdrawn message is not confirmed', () => assert.deepEqual(run({ ids: ['post', 'cancelled'], withdrawn: ['cancelled'] }), ['first', 'post']));
  test('removed or never-buffered message is not confirmed', () => assert.deepEqual(run({ ids: ['post', 'removed'], buffered: ['post'] }), ['first', 'post']));
  test('unrelated buffered user message is not confirmed', () => assert.deepEqual(run({ buffered: ['post', 'unrelated'] }), ['first', 'post']));
  test('non-user buffer entry cannot authorize a receipt', () => {
    const query = {}, events = [], session = { query, messageBuffer: [{ type: 'assistant', uuid: 'post' }] };
    new E({ emit: (...args) => events.push(args) }).finish(true, session, { queryObj: query }, { userMessageUuid: 'first', promptUuids: ['post'] }, { health: 'healthy' }, 'owner');
    assert.deepEqual(events.map(([, , id]) => id), ['first']);
  });
  test('missing promptUuids preserves ordinary completion', () => assert.deepEqual(run({ aliasesMissing: true }), ['first']));
  test('malformed promptUuids is ignored', () => assert.deepEqual(run({ ids: 'not-an-array', buffered: [] }), ['first']));
  test('empty and non-string aliases are ignored', () => assert.deepEqual(run({ ids: ['', null, 7, 'post'], buffered: ['post'] }), ['first', 'post']));
  for (const [name, options] of Object.entries({ unhealthy: { health: 'unhealthy' }, subagent: { main: false }, stale: { current: false }, adopted: { adopted: true }, missingCycle: { cycleMissing: true } })) test(`${name} never emits completion`, () => assert.deepEqual(run(options), []));
  for (const platform of ['darwin', 'win32']) test(`${platform} retains exactly upstream behavior`, () => assert.deepEqual(run({ platform }), ['first']));
  for (const enabled of [false, undefined, ABSENT, 'yes', 1]) test(`switch ${String(enabled)} keeps the plain single emit`, () => {
    assert.deepEqual(run({ enabled }), ['first']);
    assert.deepEqual(run({ enabled, ids: ['human', 'ready', 'post'] }), ['first']);
  });
  test('switch off still never emits for an unhealthy turn', () => assert.deepEqual(run({ enabled: false, health: 'unhealthy' }), []));
  test('switch on, empty promptUuids takes the plain emit', () => assert.deepEqual(run({ ids: [], buffered: [] }), ['first']));
  test('patch is idempotent with exact end-state checks', () => { const again = patch(result.text); assert.equal(again.status, 0, again.stderr); assert.equal(again.text, result.text); });
  test('patched fixture passes JavaScript syntax check', () => { fs.writeFileSync(file, result.text); assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0); });
  for (const [name, text] of Object.entries({ missing: fixture.replace('"turnCompleted"', '"otherEvent"'), duplicate: fixture.replace(EMITTER, () => EMITTER + EMITTER.replace('finish(', 'finish2(')), wrongCycle: fixture.replace('a$,s$.userMessageUuid', 'a$,other$.userMessageUuid'), changedEndState: result.text.replace('.nextCycleUuid!==', '.unrelated!=='), changedGate: result.text.replace('__cdbAutoFixMergeReadyEnabled?.()===true?', '__cdbAutoFixMergeReadyEnabled?.()!==false?'), endStatePlusOriginal: result.text.replace('finish(', () => EMITTER.replace('finish(', 'again(') + 'finish(') })) test(`rejects ${name} anchor/end-state`, () => assert.notEqual(patch(text).status, 0));
  test('both notice helpers bank the second batch member, not unrelated sends', () => {
    for (const helperFile of ['autofix_post_merge.js', 'autofix_merge_ready.js']) {
      const factory = vm.runInNewContext(fs.readFileSync(path.join(root, 'js', helperFile), 'utf8'), { process, globalThis: {}, require: name => { throw Error(`unexpected dependency ${name}`); } });
      const post = helperFile.includes('post_merge'), directory = '/isolated-account';
      const state = post ? { sessionId: 'owner', seen: [], pending: { messageId: 'post', ids: ['i77'] } } : { sessionId: 'owner', messageId: 'post', pending: true, notified: false };
      let saved = JSON.stringify(post ? { version: 1, startedAt: 1, states: { target: state }, expired: [] } : { version: 1, states: { target: state } });
      const memory = { readFileSync: () => saved, writeFileSync: (_file, text) => { saved = text; }, renameSync() {} };
      const manager = { getAccountStorageDir: () => directory, githubPr: { config: { listSessionIds: () => [], getSession: () => null } } };
      const helper = factory({ sessionManager: manager }, { fs: memory, path, userData: directory, uuid: () => 'unused', now: () => 1 });
      // Post-merge initializes lazily in sweep; readiness loads at construction.
      if (post) {
        // sweep performs synchronous loading before its first (empty) await.
        helper.sweep();
      }
      const query = {}, session = { query, messageBuffer: [{ type: 'user', uuid: 'post' }] };
      new E({ emit: (_name, owner, id) => helper.completed(owner, id) }).finish(true, session, { queryObj: query }, { userMessageUuid: 'first', promptUuids: ['post'] }, { health: 'healthy' }, 'owner');
      const stored = JSON.parse(saved).states.target;
      if (post) { assert.deepEqual(stored.seen, ['i77']); assert.equal(stored.pending, undefined); }
      else { assert.equal(stored.pending, false); assert.equal(stored.notified, true); }
    }
  });
  const build = path.join(root, 'tmp/app.asar.contents/.vite/build');
  if (fs.existsSync(build)) test('pristine release: one gated rewrite, node --check per chunk, idempotent', () => {
    const parts = fs.readdirSync(build).filter(n => /^index.*\.js$/.test(n)).map(name => ({ name, text: fs.readFileSync(path.join(build, name), 'utf8') }));
    const emitter = parts.filter(p => /\.health===["`]healthy["`]&&this\.deps\.emit\(["`]turnCompleted["`]/.test(p.text));
    const engine = parts.filter(p => p.text.includes('handleSendsDroppedUnsent('));
    assert.equal(emitter.length, 1, 'exactly one chunk holds the healthy completion emitter');
    assert.equal(engine.length, 1, 'exactly one chunk holds AutoFixEngine');
    // Stage like the orchestrator: parts joined by boundary markers, split back after.
    const chosen = [...new Set([...engine, ...emitter])], marker = name => `\n/*__CDB_SPLIT__${name}__*/\n`;
    const staged = chosen.map(p => marker(p.name) + p.text).join('');
    const once = patch(staged); assert.equal(once.status, 0, once.stderr);
    assert.equal(once.text.split('__cdbBatchReceiptIds=new Set(').length - 1, 1, 'exactly one batch receipt rewrite');
    assert.match(once.text, /\.health===["`]healthy["`]&&\(process\.platform==="linux"&&Array\.isArray\(([\w$]+)\.promptUuids\)&&\1\.promptUuids\.length>0&&globalThis\.__cdbAutoFixMergeReadyEnabled\?\.\(\)===true\?/);
    assert.doesNotMatch(once.text, /\.health===["`]healthy["`]&&this\.deps\.emit\(["`]turnCompleted["`]/, 'no unpatched healthy emitter left');
    const pieces = once.text.split(/\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/).slice(1);
    assert.equal(pieces.length, chosen.length * 2, 'chunk boundary markers intact');
    for (let i = 0; i < pieces.length; i += 2) {
      const out = path.join(temporary, pieces[i]); fs.writeFileSync(out, pieces[i + 1]);
      const check = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' }); assert.equal(check.status, 0, `${pieces[i]}: ${check.stderr}`);
    }
    const twice = patch(once.text); assert.equal(twice.status, 0, twice.stderr); assert.equal(twice.text, once.text, 'byte-idempotent on the release');
    assert.match(twice.stdout, /already present/);
  });
  else console.log('SKIP pristine release check: tmp/app.asar.contents unavailable');
  console.log(`PASS ${passed} batch receipt tests`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
