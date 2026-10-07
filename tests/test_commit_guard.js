'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('async function scmToolkitPushWithPullRetry(');
const end = source.indexOf('function scmToolkitCreateControls(', start);
const snippet = source.slice(start, end);

async function run(allowed, failCommit = false) {
  let commits = 0;
  const calls = [];
  const repository = {
    rootUri: { scheme: 'file', fsPath: '/tmp/repo' },
    async commit() {
      commits += 1;
      calls.push('commit');
      if (failCommit) throw new Error('commit failed');
    },
    async push() {}
  };
  const commands = {
    async executeCommand(command) {
      calls.push(command);
      if (command === 'sweetiebot.checkCommitLimits') return allowed;
      if (command === 'sweetiebot.beginCommit' || command === 'sweetiebot.endCommit') return undefined;
      throw new Error(`Unexpected command: ${command}`);
    }
  };
  const configuration = { getValue() { return 'none'; } };
  const notifications = { error() {} };
  const context = vm.createContext({ repository, commands, configuration, notifications });
  vm.runInContext(
    snippet + '\nscmToolkitGuardCommit(repository, commands, configuration, notifications);',
    context
  );
  try {
    await repository.commit('message', {});
  } catch (error) {
    if (!failCommit) throw error;
  }
  return { commits, calls };
}

(async () => {
  const cancelled = await run(false);
  assert.equal(cancelled.commits, 0, 'Closing the warning must cancel the commit');
  assert.deepEqual(cancelled.calls, ['sweetiebot.checkCommitLimits']);

  const allowed = await run(true);
  assert.equal(allowed.commits, 1, 'Commit anyway must allow the commit');
  assert.deepEqual(allowed.calls, [
    'sweetiebot.checkCommitLimits',
    'sweetiebot.beginCommit',
    'commit',
    'sweetiebot.endCommit'
  ]);

  const failed = await run(true, true);
  assert.equal(failed.commits, 1);
  assert.equal(failed.calls.at(-1), 'sweetiebot.endCommit',
    'A failed Git commit must still release the auto-pull pause');
  console.log('Commit guard tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
