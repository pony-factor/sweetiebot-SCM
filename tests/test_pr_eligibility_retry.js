'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
const refresh = source.match(/    const refreshPullRequest = \(\) => \{[\s\S]*?\n    };/)[0];
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(executeCommand) {
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    settings: { mcpPullRequest: true, remote: 'origin' },
    currentBranch: 'draft', currentDefaultBranch: 'main', currentBranchRevision: 'head1',
    currentRepositoryUri: { toString: () => 'file:///workspace/repository' },
    pullRequestEligibilityKey: undefined, pullRequestEligibility: undefined,
    pullRequestEligibilityRetry: undefined, pullRequestEligibilityRequest: 0,
    pending: false, deletingBranch: false, creatingPullRequest: false, creatingPonyBranch: false,
    pullRequestButton: { setAttribute() {} }, pullRequestTooltip: {},
    commands: { executeCommand },
    setTimeout(callback, delay) { assert.equal(delay, 15000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(`${refresh}\nthis.refresh = refreshPullRequest;`, context);
  return { context, timers };
}

async function run() {
  let attempts = 0;
  const { context, timers } = harness(async () => {
    if (++attempts === 1) throw new Error('Kefania was not found');
    return { allowed: true, reason: 'new-starting-base' };
  });
  context.refresh();
  await tick();
  assert.equal(context.pullRequestButton.disabled, true);
  assert.equal(timers.size, 1);
  const retry = [...timers.values()][0];
  timers.clear();
  retry();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(context.pullRequestButton.disabled, false, 'Repair enables New PR without a head change or window reload');
  context.refresh();
  assert.equal(attempts, 2, 'Successful evidence remains cached');

  const blocked = harness(async () => { throw new Error('Setup unavailable'); });
  blocked.context.refresh();
  await tick();
  blocked.context.currentBranch = 'main';
  blocked.context.refresh();
  assert.equal(blocked.timers.size, 0, 'Do not retry on the base branch');

  const pending = [];
  const switched = harness(() => new Promise(resolve => pending.push(resolve)));
  switched.context.refresh();
  switched.context.pullRequestEligibilityKey = undefined;
  switched.context.pullRequestEligibilityRequest += 1;
  switched.context.refresh();
  pending[1]({ allowed: true });
  await tick();
  pending[0]({ allowed: false, reason: 'no-commits' });
  await tick();
  assert.equal(switched.context.pullRequestButton.disabled, false, 'An older request cannot replace evidence after rebinding the same repository');
  console.log('PR eligibility recovery checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
