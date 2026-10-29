'use strict';

const assert = require('node:assert/strict');
const { registerPullRequestCommand, findOpenPullRequest } = require('../extension/github/pull_request');

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
  let publishedChecks = 0;
  let existing;
  let openChecks = 0;
  const context = { subscriptions: [] };
  registerPullRequestCommand(vscode, context, {
    findOpenPullRequest: async (_vscode, url, branch) => {
      assert.equal(url, 'https://github.com/pony-factor/sweetiebot-SCM');
      assert.equal(branch, 'feature');
      openChecks++;
      return existing;
    },
    pendingPRCommits: async () => pending ? async () => {} : undefined,
    stackedPullRequestBase: async (_root, _branch, base) => base,
    verifyPublishedBranch: async (rootPath, branch, remote) => {
      assert.equal(rootPath, '/tmp/sweetiebot-test-repository');
      assert.equal(branch, 'feature');
      assert.equal(remote, 'origin');
      publishedChecks++;
    },
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
  assert.equal(publishedChecks, 1);

  pending = true;
  assert.deepEqual(await eligibility(root, options),
    { allowed: true, reason: 'pending-commits' },
    'Queued commits permit the window to open before publication');
  assert.equal(checked, 1, 'Do not check a half-published branch');
  assert.equal(publishedChecks, 1, 'Queued work must skip remote publication preflight');
  assert.equal(openChecks, 1, 'Queued work must still check for an open PR');
  existing = { number: 531, url: 'https://github.com/pony-factor/sweetiebot-SCM/pull/531', head: 'feature', base: 'release' };
  assert.deepEqual(await eligibility(root, options),
    { allowed: false, reason: 'open-pr', pullRequest: existing },
    'An open PR on another base blocks creation even while commits are pending');
  assert.equal(checked, 1, 'Open PR lookup must not require published comparison evidence');
  existing = undefined;
  await assert.rejects(eligibility(root, { ...options, branch: 'different' }),
    /selected branch changed/, 'Pending jobs do not bypass branch identity');

  pending = false;
  assert.deepEqual(await eligibility(root, options),
    { allowed: false, reason: 'no-commits' });
  assert.equal(checked, 2, 'Restore authoritative eligibility once the queue drains');
  assert.equal(publishedChecks, 2);
  assert.equal(publishedChecks, 2, 'Recheck remote publication once the queue drains');

  const url = 'https://github.com/pony-factor/sweetiebot-SCM';
  const pr = { number: 531, html_url: url + '/pull/531', state: 'open', draft: true,
    head: { ref: 'feature', repo: { full_name: 'pony-factor/sweetiebot-SCM' } }, base: { ref: 'release' } };
  const lookup = async endpoint => {
    const parsed = new URL('https://api.github.com/' + endpoint);
    assert.equal(parsed.searchParams.get('head'), 'pony-factor:feature');
    assert.equal(parsed.searchParams.get('state'), 'open');
    assert.equal(parsed.searchParams.has('base'), false);
    return [pr];
  };
  assert.equal((await findOpenPullRequest(vscode, url, 'feature', lookup)).number, 531,
    'Draft PRs on another base also block duplicate creation');
  assert.equal(await findOpenPullRequest(vscode, url, 'feature', async () => [
    { ...pr, head: { ref: 'feature', repo: { full_name: 'someone/fork' } } },
  ]), undefined, 'A fork with the same branch name does not block this repository');
  await assert.rejects(findOpenPullRequest(vscode, url, 'feature', async () => { throw Error('Read failed'); }),
    /Read failed/, 'Failed lookup cannot authorize duplicate creation');
  console.log('Queued commit PR preflight checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
