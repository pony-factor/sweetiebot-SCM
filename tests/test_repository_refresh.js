'use strict';

const assert = require('node:assert/strict');
const { registerBranchCommands } = require('../efs/branch_actions');

(async () => {
  const commands = new Map();
  const context = { subscriptions: [] };
  const uri = { scheme: 'file', path: '/selected-checkout' };
  let repository;
  let reads = 0;
  const vscode = {
    Uri: { from: value => value },
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => ({
      repositories: [],
      getRepository: selected => { assert.equal(selected, uri); return repository; }
    }) }) }) },
    commands: {
      registerCommand(id, callback) { commands.set(id, callback); return { dispose() {} }; },
      executeCommand() { throw new Error('Background refresh must not invoke a Git picker'); }
    }
  };
  registerBranchCommands(vscode, context);
  try {
    const refresh = commands.get('sweetiebot.refreshRepository');
    assert.equal(await refresh(), false);
    assert.equal(await refresh(uri), false, 'No repositories during a workspace switch is normal');
    repository = { async status() { reads++; } };
    assert.equal(await refresh({ rootUri: uri }), true);
    assert.equal(reads, 1);
    repository.status = async () => { throw new Error('Repository disposed during switch'); };
    assert.equal(await refresh(uri), false);
    repository = undefined;
    assert.equal(await refresh(uri), false, 'A stale root must never select a different repository');
    console.log('Repository refresh tolerates checkout discovery and disposal without Git dialogs.');
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
