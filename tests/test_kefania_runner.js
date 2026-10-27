'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const paths = require('../efs/kefania_paths');
const queueModule = require('../efs/pony_publish_queue');

const originalSpawn = childProcess.spawn;
const originalResolve = paths.resolveKefaniaFile;
const originalQueue = queueModule.createPonyPublishQueue;
const calls = [], resumes = [];
let result, publication, childInput;
childProcess.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = input => { childInput = JSON.parse(input); queueMicrotask(() => {
    child.stdout.emit('data', JSON.stringify(result));
    child.emit('close', 0);
  }); };
  child.kill = () => {};
  return child;
};
paths.resolveKefaniaFile = async () => '/fixture/kefania/src/pony-cache.js';
queueModule.createPonyPublishQueue = () => ({
  resume: async root => { resumes.push(root); },
  enqueue: (...args) => { calls.push(args); return publication; }
});

(async () => {
  const { runKefaniaPonyCache, runKefania } = require('../efs/kefania_runner');
  const pony = { packId: 'g4-mares', slug: 'stardom' };
  result = { hit: true, profile: 'Existing research' };
  // Deliberately leave publication unresolved: cache hits must still return.
  publication = new Promise(() => {});
  assert.deepEqual(await runKefaniaPonyCache('/project', { action: 'get', pony }), result);
  assert.deepEqual(calls.pop(), ['/fixture/kefania', pony, 'g4-mares/stardom.json']);

  result = { stored: false, reason: 'existing-profile-preserved' };
  publication = Promise.resolve({ publicationError: 'Offline', retryScheduled: true });
  const duplicate = await runKefaniaPonyCache('/project', { action: 'put', pony, profile: 'Replacement' });
  assert.equal(duplicate.stored, false);
  assert.equal(duplicate.retryScheduled, true, 'Existing-record saves must enqueue publication again');
  assert.equal(duplicate.publicationError, 'Offline');
  assert.equal(calls.pop()[2], 'g4-mares/stardom.json');

  result = { stored: true, path: 'g4-mares/stardom.json' };
  publication = Promise.resolve({ publication: { pushed: true } });
  assert.equal((await runKefaniaPonyCache('/project', { action: 'put', pony })).publication.pushed, true);
  calls.pop();

  result = { hit: true, profile: 'Legacy canonical identity' };
  await runKefaniaPonyCache('/project', { action: 'get', pony: { packId: 'g4-stallions', slug: 'hoofar' } });
  assert.equal(calls.pop()[2], 'g4-stallions/hoo-far.json');
  result = { hit: false };
  await runKefaniaPonyCache('/project', { action: 'get', pony });
  assert.equal(calls.length, 0, 'Cache misses must not publish');
  assert.equal(resumes.length, 5, 'Every cache operation gives pending jobs a chance to resume');
  const identityMode = process.env.SWEETIEBOT_BOT_IDENTITY_MODE;
  try {
    process.env.SWEETIEBOT_BOT_IDENTITY_MODE = 'legacy';
    const input = { repository: 'owner/repo', source: { kind: 'codex', uuid: 'thread' },
      preparedDraft: { title: 'Title', body: 'Verified description with Source details' } };
    await runKefania('/project', input);
    assert.equal(childInput.source, undefined, 'Description publication must not request a separate source comment');
    assert.deepEqual(childInput.preparedDraft, input.preparedDraft);
    assert(input.source, 'The captured source metadata remains intact in the parent process');
  } finally {
    if (identityMode === undefined) delete process.env.SWEETIEBOT_BOT_IDENTITY_MODE;
    else process.env.SWEETIEBOT_BOT_IDENTITY_MODE = identityMode;
  }
  console.log('Kefania runner retry integration and immediate cache rendering checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  childProcess.spawn = originalSpawn;
  paths.resolveKefaniaFile = originalResolve;
  queueModule.createPonyPublishQueue = originalQueue;
});
