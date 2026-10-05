'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('async function scmToolkitPushWithPullRetry(');
const end = source.indexOf('function scmToolkitCreateControls(', start);
const snippet = source.slice(start, end);

async function run(allowed) {
  let commits = 0;
  const repository = {
    rootUri: { scheme: 'file', fsPath: '/tmp/repo' },
    async commit() { commits += 1; },
    async push() {}
  };
  const commands = {
    async executeCommand(command) {
      assert.equal(command, 'scmToolkit.checkCommitLimits');
      return allowed;
    }
  };
  const configuration = { getValue() { return 'none'; } };
  const notifications = { error() {} };
  const context = vm.createContext({ repository, commands, configuration, notifications });
  vm.runInContext(
    snippet + '\nscmToolkitGuardCommit(repository, commands, configuration, notifications);',
    context
  );
  await repository.commit('message', {});
  return commits;
}

(async () => {
  assert.equal(await run(false), 0, 'Closing the warning must cancel the commit');
  assert.equal(await run(true), 1, 'Commit anyway must allow the commit');
  console.log('Commit guard tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
