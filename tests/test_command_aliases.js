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
console.log('Sweetiebot command compatibility checks passed.');
