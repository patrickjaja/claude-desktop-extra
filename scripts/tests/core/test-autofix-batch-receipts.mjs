#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binary = path.join(root, 'patches/core/fix_autofix_batch_receipts');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-batch-receipts-'));
const file = path.join(temporary, 'fixture.js');
const fixture = 'class Engine{constructor(deps){this.deps=deps}finish(c$,i$,e$,s$,p$,a$){c$&&i$.query===e$.queryObj&&s$!==void 0&&!s$.adoptedByStartedCommand&&p$.health==="healthy"&&this.deps.emit("turnCompleted",a$,s$.userMessageUuid)}}';
let passed = 0;
function patch(text) { fs.writeFileSync(file, text); const run = spawnSync(binary, [file], { encoding: 'utf8' }); return { ...run, text: fs.readFileSync(file, 'utf8') }; }
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
try {
  const result = patch(fixture); assert.equal(result.status, 0, result.stderr);
  const E = vm.runInNewContext(`${result.text};Engine`, { process: { platform: 'linux' } });
  function run({ ids = ['post'], pending = [], next, buffered = ids, withdrawn = [], primary = 'first', health = 'healthy', adopted = false, current = true, main = true, platform = 'linux', cycleMissing = false, aliasesMissing = false } = {}) {
    const events = [], query = {}, session = { query, pendingEchoUuids: new Map(pending.map(id => [id, 1])), nextCycleUuid: next,
      messageBuffer: buffered.map(id => ({ type: 'user', uuid: id, isWithdrawn: withdrawn.includes(id) })) };
    const Type = platform === 'linux' ? E : vm.runInNewContext(`${result.text};Engine`, { process: { platform } });
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
  test('patch is idempotent with exact end-state checks', () => { const again = patch(result.text); assert.equal(again.status, 0, again.stderr); assert.equal(again.text, result.text); });
  test('patched fixture passes JavaScript syntax check', () => { fs.writeFileSync(file, result.text); assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0); });
  for (const [name, text] of Object.entries({ missing: fixture.replace('turnCompleted', 'otherEvent'), duplicate: fixture + fixture, wrongCycle: fixture.replace('a$,s$.userMessageUuid', 'a$,other$.userMessageUuid'), changedEndState: result.text.replace('.nextCycleUuid!==', '.unrelated!==') })) test(`rejects ${name} anchor/end-state`, () => assert.notEqual(patch(text).status, 0));
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
  console.log(`PASS ${passed} batch receipt tests`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
