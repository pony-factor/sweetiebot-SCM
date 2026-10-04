'use strict';

const assert = require('node:assert/strict');
const { squashMergePullRequest, deleteMergedRemoteBranch, registerGitHubPullRequestActions } = require('../efs/github_pr_actions');
const url = 'https://github.com/owner/repo/pull/12';
const open = { state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'topic',
  headRefOid: 'a'.repeat(40), isCrossRepository: false };

async function main() {
  const calls = [];
  const execute = async args => {
    calls.push(args);
    return { stdout: JSON.stringify({ ...open, state: calls.length > 1 ? 'MERGED' : 'OPEN' }) };
  };
  const result = await squashMergePullRequest(url, execute);
  assert.equal(result.merged, true);
  assert.deepEqual(calls[1], ['pr', 'merge', '12', '--repo', 'owner/repo', '--squash', '--match-head-commit', open.headRefOid]);
  for (const invalid of [{ isDraft: true }, { baseRefName: 'develop' }, { state: 'CLOSED' }, { headRefOid: '' }]) {
    let count = 0;
    await assert.rejects(squashMergePullRequest(url, async () => {
      count++;
      return { stdout: JSON.stringify({ ...open, ...invalid }) };
    }));
    assert.equal(count, 1);
  }
  await assert.rejects(squashMergePullRequest('https://other.example/owner/repo/pull/12', execute));
  assert.equal((await squashMergePullRequest(url, async () => ({ stdout: JSON.stringify(open) }))).merged, false);
  await assert.rejects(squashMergePullRequest(url, async args => {
    if (args[1] === 'merge') throw new Error('Required checks have not passed');
    return { stdout: JSON.stringify(open) };
  }), /Required checks/);
  const cleanup = [];
  await deleteMergedRemoteBranch(result, async args => {
    cleanup.push(args);
    return { stdout: JSON.stringify(args[0] === 'pr' ? [] : [{ ref: 'refs/heads/topic', object: { sha: open.headRefOid } }]) };
  });
  assert.deepEqual(cleanup.at(-1), ['api', '--method', 'DELETE', 'repos/owner/repo/git/refs/heads/topic']);
  for (const pr of [{ ...open, isCrossRepository: true }, { ...open, headRefName: 'main' }]) {
    await deleteMergedRemoteBranch({ ...result, pr }, () => { throw new Error('Must not delete protected/fork branch'); });
  }
  await deleteMergedRemoteBranch(result, async () => ({ stdout: '[]' }));
  await assert.rejects(deleteMergedRemoteBranch(result, async () => ({ stdout: JSON.stringify([
    { ref: 'refs/heads/topic', object: { sha: 'b'.repeat(40) } }
  ]) })), /new commits/);
  let handler;
  const errors = [];
  const refreshes = [];
  registerGitHubPullRequestActions({
    commands: { registerCommand: (id, fn) => { handler = fn; return { dispose() {} }; },
      executeCommand: async id => refreshes.push(id) },
    ProgressLocation: { Notification: 15 },
    window: { withProgress: (_, fn) => fn(), showErrorMessage: message => errors.push(message) }
  }, { subscriptions: [] });
  await handler({});
  assert.equal(errors.length, 1);
  assert.deepEqual(refreshes, ['pr.refreshList']);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
