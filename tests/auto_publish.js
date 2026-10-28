'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('    const maybePublishBranch = async branch => {');
const end = source.indexOf('\n    };', start) + '\n    };'.length;
assert(start >= 0 && end > start);

async function run() {
  const calls = [];
  let enabled = true;
  const context = vm.createContext({
    settings: { autoPublishToggle: false, defaultBranch: 'main', remote: 'origin' },
    configuration: { getValue: () => enabled },
    currentRepositoryUri: 'selected-repository',
    currentDefaultBranch: 'develop',
    publishingBranch: undefined,
    refreshAutoPublish() {},
    notifications: { info() {}, error(error) { throw error; } },
    commands: { async executeCommand(...args) { calls.push(args); return true; } }
  });
  vm.runInContext(source.slice(start, end) + '\nthis.publish = maybePublishBranch;', context);
  assert.equal(await context.publish('new-branch'), true, 'Publishing works with the cloud icon hidden');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'sweetiebot.publishBranch');
  assert.equal(calls[0][2].remote, 'origin');
  assert.equal(await context.publish('develop'), false, 'The repository default branch is skipped');
  assert.equal(await context.publish('main'), true, 'A non-default main branch remains publishable');
  enabled = false;
  assert.equal(await context.publish('another-branch'), false, 'The saved publishing switch disables publishing');
  assert.equal(calls.length, 2);
  console.log('Automatic publishing preference regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
