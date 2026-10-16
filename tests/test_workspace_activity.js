'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  findManagedGroups, registerManagedWindowActivity,
  stopManagedWindowActivity, HEARTBEAT_MS
} = require('../efs/workspace_activity');

(async () => {
  const base = '/Users/test/Library/Application Support/Sweetiebot/Workspaces';
  const group = path.join(base, 'pony-ABC123');
  const root = path.join(group, 'pony');
  const records = new Map();
  let timerCallback, timerDuration, cleared = false;
  const io = {
    async lstat(folder) { return { isDirectory: () => folder === group || folder === root }; },
    async readFile(file) {
      assert.equal(file, path.join(group, '.sweetiebot-workspace.json'));
      return JSON.stringify({ version: 1, kind: 'independent-clone', repositories: ['pony'] });
    },
    async writeFile(file, value) { records.set(file, value); },
    async utimes(file) { assert(records.has(file), 'Heartbeat is scoped to created files'); },
    async rm(file) { records.delete(file); }
  };
  const vscode = { workspace: { workspaceFolders: [
    { uri: { scheme: 'file', fsPath: root } },
    { uri: { scheme: 'file', fsPath: '/other/project' } }
  ] } };
  const groups = await findManagedGroups(vscode, {
    baseDirectory: base, io,
    async gitRoot(location) {
      if (location === root) return root;
      return '/other/project';
    }
  });
  assert.deepEqual(groups, [group]);
  const context = { subscriptions: [] };
  const oldSet = global.setInterval, oldClear = global.clearInterval;
  try {
    global.setInterval = (callback, ms) => {
      timerCallback = callback; timerDuration = ms; return 100;
    };
    global.clearInterval = id => {
      assert.equal(id, 100); cleared = true;
    };
    await registerManagedWindowActivity(vscode, context, {
      io, groups, pid: 3456, uuid: 'test'
    });
    assert.equal(timerDuration, HEARTBEAT_MS);
    assert(records.has(path.join(group, '.sweetiebot-activated')));
    assert(records.has(path.join(group, '.sweetiebot-session-3456-test.json')));
    await timerCallback();
    await stopManagedWindowActivity();
    assert(cleared);
    assert(!records.has(path.join(group, '.sweetiebot-session-3456-test.json')));
    assert(records.has(path.join(group, '.sweetiebot-activated')),
      'An earlier activation remains distinguishable from Restricted Mode');
  } finally {
    global.setInterval = oldSet; global.clearInterval = oldClear;
  }
  console.log('Managed workspace activity and lifecycle checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
