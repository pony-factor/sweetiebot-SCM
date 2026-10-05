'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let tick, enabled = true, fetches = 0, merges = 0, cleared = false;
const main = { rootUri: { scheme: 'file', fsPath: '/repo' }, state: {
  HEAD: { name: 'main', commit: 'base', upstream: { remote: 'origin', name: 'main' }, ahead: 0, behind: 1 },
  indexChanges: [{}], workingTreeChanges: [{}], mergeChanges: []
}, async status() {}, async fetch() { fetches++; } };
const topic = { rootUri: { scheme: 'file', fsPath: '/topic' }, state: { HEAD: { name: 'topic' } }, async status() {} };
const sandbox = { module: { exports: {} }, __dirname: path.dirname(require.resolve('../efs/branch_actions')), process,
  require(name) {
    if (name === 'node:util') return { promisify(fn) { return (...args) => new Promise((resolve, reject) =>
      fn(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))); } };
    if (name === 'node:child_process') return { execFile(command, args, options, callback) {
      assert.equal(command, 'git');
      if (args[0] === 'config') callback(null, enabled ? 'true\n' : 'false\n', '');
      else { assert.deepEqual(Array.from(args), ['merge', '--ff-only', 'refs/remotes/origin/main']); merges++; main.state.HEAD.behind = 0; callback(null, '', ''); }
    } };
    return require(name);
  },
  setInterval(callback, delay) { assert.equal(delay, 60000); tick = callback; return { unref() {} }; },
  clearInterval() { cleared = true; }
};
vm.runInNewContext(fs.readFileSync(require.resolve('../efs/branch_actions'), 'utf8'), sandbox);
const context = { subscriptions: [] };
const vscode = { commands: { registerCommand() { return { dispose() {} }; } }, extensions: {
  getExtension() { return { async activate() { return { getAPI() { return { repositories: [main, topic] }; } }; } }; }
} };
(async () => {
  sandbox.module.exports.registerBranchCommands(vscode, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1, 'Main fetches without any renderer or commit input widget');
  assert.equal(merges, 1, 'Nonconflicting local edits do not suppress pulling');
  tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(fetches, 2); assert.equal(merges, 1);
  enabled = false; tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(fetches, 2);
  context.subscriptions.at(-1).dispose(); assert(cleared);
  enabled = true; tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(fetches, 2);
  console.log('Main auto-pull works without a rendered input and respects disable/dispose.');
})().catch(error => { console.error(error); process.exitCode = 1; });
