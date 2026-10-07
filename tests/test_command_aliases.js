'use strict';

const assert = require('node:assert/strict');
const { registerLegacyCommandAliases } = require('../efs/command_aliases');
const manifest = require('../efs/package.json');
const handlers = new Map();
const calls = [];
const context = { subscriptions: [] };
registerLegacyCommandAliases({ commands: {
  registerCommand(id, handler) {
    handlers.set(id, handler);
    return { dispose() { handlers.delete(id); } };
  },
  executeCommand(...args) { calls.push(args); return 'forwarded'; }
} }, context);
const uri = { scheme: 'file', path: '/selected' };
for (const [legacy, handler] of handlers) {
  const current = legacy.replace(/^scmToolkit\./, 'sweetiebot.');
  assert(manifest.activationEvents.includes(`onCommand:${legacy}`));
  assert(manifest.activationEvents.includes(`onCommand:${current}`));
  assert.equal(handler(uri, { fetch: true }), 'forwarded');
  assert.deepEqual(calls.at(-1), [current, uri, { fetch: true }]);
}
assert(handlers.has('scmToolkit.prepareCodexCommit'));
for (const subscription of context.subscriptions) subscription.dispose();
assert.equal(handlers.size, 0);

const existing = () => 'legacy-owner';
const duplicateHandlers = new Map([['scmToolkit.squashMergeSelectedPullRequest', existing]]);
const duplicateContext = { subscriptions: [] };
assert.doesNotThrow(() => registerLegacyCommandAliases({ commands: {
  registerCommand(id, handler) {
    if (duplicateHandlers.has(id)) throw new Error(`command '${id}' already exists`);
    duplicateHandlers.set(id, handler);
    return { dispose() { duplicateHandlers.delete(id); } };
  },
  executeCommand() { throw new Error('Compatibility alias should not execute during registration'); }
} }, duplicateContext));
assert.equal(duplicateHandlers.get('scmToolkit.squashMergeSelectedPullRequest'), existing);
assert(duplicateHandlers.has('scmToolkit.openPullRequestBatchChat'));
for (const subscription of duplicateContext.subscriptions) subscription.dispose();
assert.equal(duplicateHandlers.size, 1);
assert.equal(duplicateHandlers.get('scmToolkit.squashMergeSelectedPullRequest'), existing);

assert.throws(() => registerLegacyCommandAliases({ commands: {
  registerCommand() { throw new Error('registration backend failed'); }
} }, { subscriptions: [] }), /registration backend failed/);

console.log('Sweetiebot command compatibility checks passed.');
