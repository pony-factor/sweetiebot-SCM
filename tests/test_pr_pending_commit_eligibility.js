'use strict';

const assert = require('node:assert/strict');
const { registerPullRequestCommand } = require('../efs/pull_request');

async function run() {
  const root = { scheme: 'file', fsPath: '/tmp/sweetiebot-test-repository' };
  const repository = {
    rootUri: root,
    state: {
      HEAD: { name: 'feature' },
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/pony-factor/sweetiebot-SCM.git' }],
    },
    async status() {},
  };
  const registered = new Map();
  const vscode = {
    Uri: { from: uri => uri },
    commands: {
      registerCommand(name, callback) {
        registered.set(name, callback);
        return { dispose() {} };
      },
    },
    extensions: {
      getExtension(id) {
        return id === 'vscode.git' ? {
          async activate() {
            return { getAPI: () => ({ getRepository: () => repository }) };
          },
        } : undefined;
      },
    },
    window: {},
  };
  let pending = false;
  let checked = 0;
  const context = { subscriptions: [] };
  registerPullRequestCommand(vscode, context, {
    pendingPRCommits: async () => pending ? async () => {} : undefined,
    runKefania: async () => {
      checked++;
      return { newPullRequest: { allowed: false, reason: 'no-commits' } };
    },
  });

  const eligibility = registered.get('sweetiebot.pullRequestEligibility');
  const options = { branch: 'feature', base: 'main', remote: 'origin' };
  assert.deepEqual(await eligibility(root, options),
    { allowed: false, reason: 'no-commits' },
    'No published commits without queued work must remain ineligible');
  assert.equal(checked, 1);

  pending = true;
  assert.deepEqual(await eligibility(root, options),
    { allowed: true, reason: 'pending-commits' },
    'Queued commits permit the window to open before publication');
  assert.equal(checked, 1, 'Do not check a half-published branch');
  await assert.rejects(eligibility(root, { ...options, branch: 'different' }),
    /selected branch changed/, 'Pending jobs do not bypass branch identity');

  pending = false;
  assert.deepEqual(await eligibility(root, options),
    { allowed: false, reason: 'no-commits' });
  assert.equal(checked, 2, 'Restore authoritative eligibility once the queue drains');
  console.log('Queued commit PR preflight checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
