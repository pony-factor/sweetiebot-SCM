'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
const warningPreference = source.match(/function scmToolkitHighlightPrWarnings\([\s\S]*?\n}/)[0];
const refresh = source.match(/    const refreshPullRequest = \(\) => \{[\s\S]*?\n    };/)[0];
const settingsAttachment = source.match(/function scmToolkitAttachCommitSettings\([\s\S]*?\n}\n\nasync function scmToolkitPullCleanRepository/)[0];
assert.match(settingsAttachment, /widget\.element\.append\(button\)/,
  'Magic Settings must remain reachable while VS Code has no action dropdown');
assert.match(settingsAttachment, /const destination = dropdown \|\| widget\.element/,
  'Magic Settings must return to its inline fallback when action rows are recycled');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(executeCommand) {
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    settings: { mcpPullRequest: true, remote: 'origin' },
    configuration: { getValue() { return undefined; } },
    currentBranch: 'draft', currentDefaultBranch: 'main', currentBranchRevision: 'head1',
    currentRepositoryUri: { toString: () => 'file:///workspace/repository' },
    pullRequestEligibilityKey: undefined, pullRequestEligibility: undefined,
    pullRequestEligibilityRetry: undefined, pullRequestEligibilityRequest: 0,
    pending: false, deletingBranch: false, creatingPullRequest: false, creatingPonyBranch: false,
    pullRequestButton: { setAttribute() {}, classList: { toggle() {} } }, pullRequestTooltip: {},
    commands: { executeCommand },
    setTimeout(callback, delay) { assert([15000, 60000].includes(delay)); timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(`${warningPreference}\n${refresh}\nthis.refresh = refreshPullRequest;`, context);
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
  assert.equal(context.pullRequestButton.disabled, false, 'Access failures stay clickable for setup recovery');
  assert.equal(timers.size, 1);
  const retry = [...timers.values()][0].callback;
  timers.clear();
  retry();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(context.pullRequestButton.disabled, false, 'Repair enables New PR without a head change or window reload');
  context.refresh();
  assert.equal(attempts, 2, 'Successful evidence remains cached');

  const throttled = harness(async () => { throw new Error('GitHub App request failed (HTTP 422).'); });
  throttled.context.refresh();
  await tick();
  assert.equal([...throttled.timers.values()][0].delay, 60000,
    'Avoid high-frequency token issuance after GitHub rejects an App check');
  assert.equal(throttled.context.pullRequestButton.disabled, false, 'A manual retry remains possible');

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
  const deferred = harness(async () => ({ allowed: true, reason: 'pending-commits' }));
  deferred.context.refresh();
  await tick();
  assert.equal(deferred.context.pullRequestButton.disabled, false,
    'Queued commit titles must not block opening a New PR window');
  const unqueued = harness(async () => ({ allowed: false, reason: 'no-commits' }));
  unqueued.context.refresh();
  await tick();
  assert.equal(unqueued.context.pullRequestButton.disabled, true,
    'Without a pending commit, the existing no-commits guard remains');
  console.log('PR eligibility recovery checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
