'use strict';
const assert = require('node:assert/strict');
const { squashMergePullRequest } = require('../extension/merge/merge_pull_request');
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergedSha = 'c'.repeat(40);
const input = { repository: 'owner/repo', head: 'feature', base: 'main', result: { number: 4, url: 'https://github.com/owner/repo/pull/4' } };
function fixture({ checksFail = false, baseMoves = false } = {}) {
  let merged = false, writes = 0, baseReads = 0;
  const request = async (endpoint, options) => {
    if (options) {
      assert.equal(options.body.merge_method, 'merge'); assert.equal(options.body.sha, head);
      writes++; merged = true; return { merged: true, sha: mergedSha };
    }
    if (endpoint === 'user') return { login: 'human', type: 'User' };
    if (endpoint === 'repos/owner/repo') return { allow_merge_commit: true };
    if (endpoint.includes('/branches/')) return { commit: { sha: baseMoves && ++baseReads > 1 ? mergedSha : base } };
    if (endpoint.includes('/commits?')) return [{ sha: head, author: { login: 'human', type: 'User' }, commit: {
      author: { name: 'Human', email: 'human@example.test' }, message: '✨ Add feature\n\nKeep the existing behavior.' } }];
    if (endpoint.includes('/check-runs?')) return { check_runs: checksFail ? [{ status: 'completed', conclusion: 'failure', name: 'tests' }] : [] };
    if (endpoint.includes('/check-suites?')) return { check_suites: [] };
    if (endpoint.includes('/status?')) return { statuses: [] };
    if (endpoint.endsWith('/commits/' + mergedSha)) return { parents: [{ sha: base }, { sha: head }], author: { login: 'human', type: 'User' } };
    return { html_url: input.result.url, state: merged ? 'closed' : 'open', merged, merge_commit_sha: merged ? mergedSha : null,
      title: '✨ Add feature', user: { login: 'automation[bot]', type: 'Bot' },
      head: { sha: head, ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } } };
  };
  return { request, writes: () => writes };
}
(async () => {
  const normal = fixture();
  const result = await squashMergePullRequest(input, normal.request, { method: 'merge' });
  assert(result.merged && result.authorsPreserved); assert.equal(normal.writes(), 1);
  for (const config of [{ checksFail: true }, { baseMoves: true }]) {
    const test = fixture(config);
    await assert.rejects(squashMergePullRequest(input, test.request, { method: 'merge' }), /checks|changed/);
    assert.equal(test.writes(), 0);
  }
  const defaultAction = fixture();
  await assert.rejects(squashMergePullRequest(input, defaultAction.request, { humanMerge: async () => ({
    merged: false, needsAuthorChoice: true, reason: 'Choose the author-preserving merge route.'
  }) }), error => error.code === 'SQUASH_AUTHOR_CHOICE_REQUIRED');
  assert.equal(defaultAction.writes(), 0, 'The default squash must not silently switch merge methods');
  console.log('Explicit author-preserving merge, ancestry checks, check failures and base races passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
