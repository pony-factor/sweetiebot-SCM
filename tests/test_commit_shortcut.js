'use strict';

const assert = require('node:assert/strict');
const { registerCommitShortcut } = require('../efs/commit_shortcut');
const manifest = require('../efs/package.json');

(async () => {
  const calls = [];
  const handlers = new Map();
  const context = { subscriptions: [] };
  const vscode = { commands: {
    registerCommand(id, handler) {
      assert.equal(id, 'sweetiebot.commit');
      handlers.set(id, handler);
      return { dispose() { handlers.delete(id); } };
    },
    executeCommand(...args) { calls.push(args); return Promise.resolve('native commit completed'); }
  } };

  registerCommitShortcut(vscode, context);
  assert(manifest.activationEvents.includes('onCommand:sweetiebot.commit'));
  assert(manifest.contributes.commands.some(c => c.command === 'sweetiebot.commit'));
  const bindings = manifest.contributes.keybindings.filter(b => b.command === 'sweetiebot.commit');
  assert.equal(bindings.length, 0, 'The Commit command starts unbound, not on F6');
  assert.equal(await handlers.get('sweetiebot.commit')(), 'native commit completed');
  assert.deepEqual(calls, [['git.commit']],
    'Use the native Source Control commit command, not a second commit implementation');
  context.subscriptions.forEach(disposable => disposable.dispose());
  assert.equal(handlers.size, 0);
  console.log('Commit shortcut tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
