'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  findManagedGroups, registerManagedWindowActivity,
  stopManagedWindowActivity, HEARTBEAT_MS
} = require('../extension/branches/workspace_activity');

(async () => {
  const base = '/Users/test/Library/Application Support/Sweetiebot/Workspaces';
  const group = path.join(base, 'pony', 'ABC123');
  const root = path.join(group, 'pony');
  const records = new Map();
  let timerCallback, timerDuration, cleared = false;
  const io = {
    async lstat(folder) { return { isDirectory: () => folder === path.join(base, 'pony') || folder === group || folder === root }; },
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
  // The main branch may be checked out in a linked worktree, while the saved
  // VS Code window file has its own identity. Both must receive live markers.
  const saved = path.join(base, 'pony', 'main-teal');
  const savedFile = path.join(saved, 'main-teal.code-workspace');
  const mainGroup = path.join(base, 'pony', 'main-azure');
  const mainCheckout = path.join(mainGroup, 'pony');
  const savedRecords = new Map();
  const savedIo = {
    async lstat(folder) {
      return {
        isDirectory: () => [path.join(base, 'pony'), saved, mainGroup, mainCheckout].includes(folder),
        isFile: () => folder === savedFile,
        isSymbolicLink: () => false
      };
    },
    async readFile(file) {
      if (file === path.join(saved, '.sweetiebot-workspace.json')) {
        return JSON.stringify({ version: 1, kind: 'shared-main', repositories: [] });
      }
      if (file === path.join(mainGroup, '.sweetiebot-workspace.json')) {
        return JSON.stringify({ version: 1, kind: 'main-worktree', repositories: ['pony'] });
      }
      throw Error('Unexpected manifest: ' + file);
    },
    async writeFile(file, value) { savedRecords.set(file, value); },
    async utimes(file) { assert(savedRecords.has(file), 'Saved window heartbeat has a registered file'); },
    async rm(file) { savedRecords.delete(file); }
  };
  const savedWindow = { workspace: {
    workspaceFile: { scheme: 'file', fsPath: savedFile },
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: mainCheckout } }]
  } };
  const tracked = await findManagedGroups(savedWindow, {
    baseDirectory: base, io: savedIo, async gitRoot() { return mainCheckout; }
  });
  assert.deepEqual(new Set(tracked), new Set([saved, mainGroup]));

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
    await registerManagedWindowActivity(savedWindow, { subscriptions: [] }, {
      io: savedIo, groups: tracked, pid: 3456, uuid: 'saved'
    });
    for (const activeGroup of tracked) {
      assert(savedRecords.has(path.join(activeGroup, '.sweetiebot-activated')),
        'Open branch/color-named windows activate each managed group');
      assert(savedRecords.has(path.join(activeGroup, '.sweetiebot-session-3456-saved.json')),
        'Open branch/color-named windows register a live session');
    }
    await timerCallback();
    await stopManagedWindowActivity();
    for (const activeGroup of tracked) {
      assert(!savedRecords.has(path.join(activeGroup, '.sweetiebot-session-3456-saved.json')));
    }
  } finally {
    global.setInterval = oldSet; global.clearInterval = oldClear;
  }
  console.log('Managed workspace activity and lifecycle checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
