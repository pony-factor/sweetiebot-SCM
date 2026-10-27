'use strict';

const assert = require('node:assert/strict');
const { registerCommitShortcut } = require('../extension/commits/shortcut');
const { resolveCommitRepository } = require('../extension/commits/codex_commit');
const manifest = require('../extension/package.json');

(async () => {
  const calls = [];
  const handlers = new Map();
  const context = { subscriptions: [] };
  const makeRepository = name => ({
    rootUri: { fsPath: '/repos/' + name, toString() { return this.fsPath; } },
    inputBox: { value: '' }
  });
  const first = makeRepository('first');
  const second = makeRepository('second');
  let repositories = [first];
  let pickResult;
  let pickerItems;
  const vscode = {
    Uri: { from: uri => uri },
    extensions: { getExtension(id) {
      assert.equal(id, 'vscode.git');
      return { async activate() {
        return { getAPI(version) {
          assert.equal(version, 1);
          return {
            getRepository(uri) { return repositories.find(repo => repo.rootUri.fsPath === uri.fsPath); },
            get repositories() { return repositories; }
          };
        } };
      } };
    } },
    window: {
      activeTextEditor: undefined,
      async showQuickPick(items) {
        pickerItems = items;
        return pickResult === undefined ? undefined : items[pickResult];
      }
    },
    commands: {
      registerCommand(id, handler) {
        assert.equal(id, 'sweetiebot.commit');
        handlers.set(id, handler);
        return { dispose() { handlers.delete(id); } };
      },
      executeCommand(...args) {
        calls.push(args);
        return Promise.resolve('native commit completed');
      }
    }
  };

  registerCommitShortcut(vscode, context);
  assert(manifest.activationEvents.includes('onCommand:sweetiebot.commit'));
  assert(manifest.contributes.commands.some(c => c.command === 'sweetiebot.commit'));
  const bindings = manifest.contributes.keybindings.filter(b => b.command === 'sweetiebot.commit');
  assert.equal(bindings.length, 0, 'The Commit shortcut starts unbound');

  // A prefilled title in the only repository commits through native Git.
  first.inputBox.value = 'Already drafted title';
  assert.equal(await handlers.get('sweetiebot.commit')(), 'native commit completed');
  assert.deepEqual(calls.pop(), ['git.commit', first.rootUri]);
  assert.equal(first.inputBox.value, 'Already drafted title', 'Native Git owns input clearing');

  // A draft must win over a different active editor in a multi-repo workspace.
  repositories = [first, second];
  vscode.window.activeTextEditor = { document: { uri: { fsPath: '/repos/second/file.js' } } };
  await handlers.get('sweetiebot.commit')();
  assert.deepEqual(calls.pop(), ['git.commit', first.rootUri]);
  assert.equal(first.inputBox.value, 'Already drafted title');
  assert.equal(second.inputBox.value, '');

  // Both shortcuts share the same draft-aware repository resolver.
  assert.equal(await resolveCommitRepository(vscode), first);

  // If two repositories contain drafts, respect the explicit editor match.
  second.inputBox.value = 'Another draft';
  assert.equal(await resolveCommitRepository(vscode), second);

  // Without a matching editor, ask which draft to commit; cancellation is safe.
  vscode.window.activeTextEditor = undefined;
  pickResult = 1;
  await handlers.get('sweetiebot.commit')();
  assert.deepEqual(pickerItems.map(item => item.repository), [first, second]);
  assert.deepEqual(calls.pop(), ['git.commit', second.rootUri]);
  pickResult = undefined;
  const beforeCancel = calls.length;
  await handlers.get('sweetiebot.commit')();
  assert.equal(calls.length, beforeCancel, 'Never guess among multiple commit drafts');

  // With empty drafts, use the active editor instead of another repository.
  first.inputBox.value = '';
  second.inputBox.value = '';
  vscode.window.activeTextEditor = { document: { uri: { fsPath: '/repos/first/file.js' } } };
  await handlers.get('sweetiebot.commit')();
  assert.deepEqual(calls.pop(), ['git.commit', first.rootUri]);

  // An explicit repository argument always wins, even with a different draft.
  second.inputBox.value = 'Another draft';
  await handlers.get('sweetiebot.commit')(first.rootUri);
  assert.deepEqual(calls.pop(), ['git.commit', first.rootUri]);

  context.subscriptions.forEach(disposable => disposable.dispose());
  assert.equal(handlers.size, 0);
  console.log('Commit shortcut and prefilled title regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
