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
  let conflictCalls = 0;
  await assert.rejects(squashMergePullRequest(url, async () => {
    conflictCalls++;
    return { stdout: JSON.stringify({ ...open, mergeable: 'CONFLICTING' }) };
  }), /PR #12 has merge conflicts with main/);
  assert.equal(conflictCalls, 1, 'Do not attempt to merge known conflicts');
  let racedReads = 0;
  await assert.rejects(squashMergePullRequest(url, async args => {
    if (args[1] === 'merge') throw Object.assign(new Error('gh failed'), { stderr: 'not mergeable' });
    return { stdout: JSON.stringify({ ...open, mergeable: ++racedReads === 1 ? 'UNKNOWN' : 'CONFLICTING' }) };
  }), /Resolve the conflicts on topic/);
  const originalFailure = Object.assign(new Error('gh failed'), { stderr: 'Required checks have not passed' });
  let failedReads = 0;
  await assert.rejects(squashMergePullRequest(url, async args => {
    if (args[1] === 'merge') throw originalFailure;
    if (++failedReads > 1) throw new Error('Offline');
    return { stdout: JSON.stringify(open) };
  }), error => error === originalFailure);
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
  const missingRefs = [404, 422].map(status => Object.assign(new Error('gh failed'), {
    stderr: `gh: Reference does not exist (HTTP ${status})`
  }));
  missingRefs.push(new Error('gh: Reference does not exist (HTTP 422)'));
  const topicRef = { ref: 'refs/heads/topic', object: { sha: open.headRefOid } };
  const prefixedRef = { ref: 'refs/heads/topic-other', object: { sha: open.headRefOid } };
  for (const missingRef of missingRefs) {
    for (const remaining of [[], [prefixedRef]]) {
      let lookups = 0;
      await deleteMergedRemoteBranch(result, async args => {
        if (args.includes('DELETE')) throw missingRef;
        if (args[0] === 'pr') return { stdout: '[]' };
        return { stdout: JSON.stringify(++lookups === 1 ? [topicRef] : remaining) };
      });
      assert.equal(lookups, 2, 'Confirm automatic deletion after a raced DELETE');
    }
  }
  for (const failure of [...missingRefs, Object.assign(new Error('Forbidden'), { stderr: 'gh: Forbidden (HTTP 403)' })]) {
    await assert.rejects(deleteMergedRemoteBranch(result, async args => {
      if (args.includes('DELETE')) throw failure;
      return { stdout: JSON.stringify(args[0] === 'pr' ? [] : [topicRef]) };
    }), error => error === failure);
  }
  for (const missingRef of missingRefs) {
    let lookups = 0;
    await assert.rejects(deleteMergedRemoteBranch(result, async args => {
      if (args.includes('DELETE')) throw missingRef;
      if (args[0] === 'pr') return { stdout: '[]' };
      if (++lookups > 1) throw new Error('Lookup failed');
      return { stdout: JSON.stringify([topicRef]) };
    }), /Lookup failed/);
  }
  const validationFailure = Object.assign(new Error('gh failed'), {
    stderr: 'gh: Validation Failed (HTTP 422)'
  });
  let validationLookups = 0;
  await assert.rejects(deleteMergedRemoteBranch(result, async args => {
    if (args.includes('DELETE')) throw validationFailure;
    if (args[0] === 'pr') return { stdout: '[]' };
    return { stdout: JSON.stringify(++validationLookups === 1 ? [topicRef] : []) };
  }), error => error === validationFailure);
  assert.equal(validationLookups, 1, 'Other 422 errors must remain actionable');
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
  const selected = [];
  const notices = [];
  registerGitHubPullRequestActions({
    commands: { registerCommand: (id, fn) => { handler = fn; return { dispose() {} }; },
      executeCommand: async id => refreshes.push(id) },
    ProgressLocation: { Notification: 15 },
    window: { withProgress: (_, fn) => fn(), showErrorMessage: message => errors.push(message),
      showInformationMessage: message => notices.push(message) }
  }, { subscriptions: [] }, async selectedUrl => {
    selected.push(selectedUrl);
    return { merged: false, number: '12' };
  });
  // GitHub PR tree nodes expose the normalized model URL, not REST's html_url.
  await handler({ pullRequestModel: { url, number: 12 } });
  await handler({ url, number: 12 });
  await handler({ pullRequestModel: { html_url: url, number: 12 } });
  await handler({ htmlUrl: `${url}/`, number: 12 });
  await handler({ resourceUri: { query: JSON.stringify({ prIdentifier: 'git@github.com:owner/repo.git:12' }) } });
  assert.deepEqual(selected, [url, url, url, url, url]);
  assert.equal(errors.length, 1);
  assert.equal(notices.length, 5);
  assert.deepEqual(refreshes, Array(6).fill('pr.refreshList'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
