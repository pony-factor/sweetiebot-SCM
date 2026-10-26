'use strict';
const assert = require('node:assert/strict');
const { reloadBlockReason, rememberAutomaticReload, RELOAD_HISTORY_KEY } = require('../efs/ui/reload_guard');

async function run() {
  const records = new Map();
  const context = { workspaceState: {
    get(key, fallback) { return records.has(key) ? records.get(key) : fallback; },
    async update(key, value) { records.set(key, value); }
  } };
  const now = Date.now();
  assert.equal(reloadBlockReason(context, 'revision-a', now), '');
  await rememberAutomaticReload(context, 'revision-a', now);
  assert.equal(records.get(RELOAD_HISTORY_KEY).length, 1);
  assert.match(reloadBlockReason(context, 'revision-a', now + 1), /same update/);
  assert.equal(reloadBlockReason(context, 'revision-b', now + 1), '');
  await rememberAutomaticReload(context, 'revision-b', now + 1);
  assert.match(reloadBlockReason(context, 'revision-c', now + 2), /too many reloads/);
  assert.equal(reloadBlockReason(context, 'revision-c', now + 10 * 60 * 1000 + 2), '');
  assert.equal(reloadBlockReason({ workspaceState: { get() { return 'invalid'; } } }, 'revision-d', now), '');
  assert.equal(reloadBlockReason({}, 'revision-d', now), '');
  console.log('Persistent automatic-reload loop protection checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
