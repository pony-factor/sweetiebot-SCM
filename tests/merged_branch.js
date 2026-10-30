'use strict';
const assert = require('node:assert/strict');
const { warnMergedBranch } = require('../extension/branches/merged_branch');

(async () => {
  const uri = { fsPath: '/repo' };
  const info = { branch: 'old', number: 61, defaultBranch: 'main', remote: 'origin' };
  const calls = [];
  let choice;
  const vscode = {
    window: { async showWarningMessage(message, options, action) {
      assert.match(message, /old.*merged in PR #61/);
      assert.equal(options.modal, true);
      assert.equal(action, 'Continue on new branch from old');
      return choice;
    } },
    commands: { async executeCommand(...args) { calls.push(args); } }
  };
  await warnMergedBranch(vscode, { rootUri: uri }, info);
  assert.equal(calls.length, 0, 'dismissing the warning must not change branches');
  assert.equal(await warnMergedBranch({ window: { showWarningMessage: assert.fail } },
    { rootUri: uri }, info, { silent: true }), 'already-merged',
  'an automatic publish check must silently skip a merged head without reopening recovery');
  assert.equal(calls.length, 0, 'a silent check must never create a recovery branch');
  choice = 'Continue on new branch from old';
  await warnMergedBranch(vscode, { rootUri: uri }, info);
  assert.deepEqual(calls, [['sweetiebot.createBranch', uri, {
    remote: 'origin', continueFromBranch: 'old'
  }]], 'the popup must use the old local branch tip instead of main');
  console.log('Merged-branch warning action checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
