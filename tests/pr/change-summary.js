'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsePullRequestUrl, formatChangeSummary, readPullRequest,
  publishChangeSummary, MARKER_PREFIX } = require('../../extension/github/pr-change-summary');

(async () => {
  const url = 'https://github.com/external-org/project/pull/42';
  const headSha = 'a'.repeat(40);
  assert.deepEqual(parsePullRequestUrl(url), {
    repository: 'external-org/project', number: 42, url
  });
  for (const invalid of ['http://github.com/x/y/pull/1',
    'https://github.com.evil.test/x/y/pull/1',
    'https://github.com/x/y/issues/1',
    'https://github.com/x/y/pull/0',
    'https://github.com/x/y/pull/1?redirect=https://evil.test',
    'https://attacker@github.com/x/y/pull/1']) {
    assert.throws(() => parsePullRequestUrl(invalid));
  }
  const pr = { url, state: 'OPEN', headRefOid: headSha, title: 'Fix the feature',
    baseRefName: 'main',
    commits: [{ messageHeadline: '🐛 Repair API retry handling' },
      { messageHeadline: '🔄 Sync branch to main' },
      { messageHeadline: '🧪 Cover retry behavior' }],
    files: [{ path: 'extension/github/retry.js' }, { path: 'tests/pr/retry.js' }] };
  const summary = formatChangeSummary(pr);
  assert.match(summary, /Repair API retry handling/);
  assert.match(summary, /Cover retry behavior/);
  assert.doesNotMatch(summary, /Sync branch to main/);
  assert.match(summary, /extension\/github\//);

  const calls = [];
  let comments = [];
  let posted = 0;
  let issueStyleUrl = false;
  const exec = async args => {
    calls.push(args);
    if (args[0] === 'pr') return JSON.stringify(pr);
    if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ login: 'contributor' });
    if (args[0] === 'api' && args[1]?.includes('?per_page=')) return JSON.stringify(comments);
    if (args[0] === 'api' && args[1] === '-X') {
      posted++;
      assert.equal(args[2], 'POST');
      assert.equal(args[3], 'repos/external-org/project/issues/42/comments');
      assert.match(args[5], new RegExp(MARKER_PREFIX + headSha));
      assert.match(args[5], /Reviewed change summary/);
      return JSON.stringify({ html_url: issueStyleUrl
        ? 'https://github.com/external-org/project/issues/42#issuecomment-50'
        : url + '#issuecomment-50' });
    }
    throw Error('Unexpected GitHub request ' + JSON.stringify(args));
  };
  assert.equal((await readPullRequest(url, exec)).number, 42);
  await assert.rejects(publishChangeSummary({ url, headSha: 'b'.repeat(40),
    body: 'Reviewed change summary' }, exec), /head changed/);
  assert.equal(posted, 0, 'A stale PR revision must not produce a comment');
  const result = await publishChangeSummary({ url, headSha, body: 'Reviewed change summary' }, exec);
  assert.equal(result.alreadyPosted, false);
  assert.equal(result.url, url + '#issuecomment-50');
  assert.equal(posted, 1);
  comments = [{ user: { login: 'contributor' },
    body: 'Reviewed change summary\n\n' + MARKER_PREFIX + headSha + ' -->',
    html_url: url + '#issuecomment-50' }];
  assert.equal((await publishChangeSummary({ url, headSha, body: 'Reviewed change summary' }, exec)).alreadyPosted, true);
  assert.equal(posted, 1, 'The same author must not post a duplicate summary for the same revision');
  comments = [{ user: { login: 'someone-else' },
    body: MARKER_PREFIX + headSha + ' -->' }];
  issueStyleUrl = true;
  const issueStylePost = await publishChangeSummary({ url, headSha, body: 'Reviewed change summary' }, exec);
  assert.equal(posted, 2, 'Another author must not suppress this user’s comment');
  assert.equal(issueStylePost.url, 'https://github.com/external-org/project/issues/42#issuecomment-50',
    'GitHub may return an issue-style URL for a pull request conversation comment');
  assert(calls.some(args => args[0] === 'api' && args[1] === 'user'),
    'Posting must use the active GitHub CLI author identity');
  assert.match(fs.readFileSync(path.join(__dirname, '../../extension/ui/pr-change-summary.html'), 'utf8'),
    /Post summary to GitHub/);
  console.log('PR change summary tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
