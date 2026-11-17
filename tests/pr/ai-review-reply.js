'use strict';
const assert = require('node:assert/strict');
const {
  parseRemote, reviewSelection, findReviewPullRequests, matchesReviewHead,
  checkPublished, parseAssessment, replyBody
} = require('../../extension/codex/ai-review-reply');

async function run() {
  assert.equal(parseRemote('git@github.com:pony-factor/sweetiebot-SCM.git'),
    'pony-factor/sweetiebot-SCM');
  assert.equal(parseRemote('https://github.com/pony-factor/sweetiebot-SCM'),
    'pony-factor/sweetiebot-SCM');
  assert.equal(parseRemote('https://evil.example/repo'), null);
  assert.equal(parseRemote('https://github.com/a/b/other'), null);
  const routes = [];
  const head = { ref: 'fix/review', repo: { full_name: 'contributor/project' } };
  const request = async (_token, route) => {
    routes.push(route);
    if (route === '/repos/contributor/project') return {
      full_name: 'contributor/project', fork: true, parent: { full_name: 'upstream/project' }
    };
    if (route.startsWith('/repos/contributor/project/pulls?')) return [];
    assert.match(route, /^\/repos\/upstream\/project\/pulls\?/);
    return [
      { number: 9054, state: 'open', head },
      { number: 2, state: 'open', head: { ...head, repo: { full_name: 'other/project' } } },
      { number: 3, state: 'open', head: { ...head, ref: 'other-branch' } }
    ];
  };
  const found = await findReviewPullRequests('test', 'contributor/project', 'fix/review', request);
  assert.equal(found.length, 1);
  assert.equal(found[0].number, 9054);
  assert.equal(found[0].reviewRepository, 'upstream/project');
  assert.match(routes[2], /head=contributor%3Afix%2Freview/);
  const sameRepo = await findReviewPullRequests('test', 'contributor/project', 'fix/review',
    async (_token, route) => route.includes('/pulls?') ? [{ number: 1, state: 'open', head }] :
      { full_name: 'contributor/project', fork: false });
  assert.equal(sameRepo[0].reviewRepository, 'contributor/project');
  await assert.rejects(() => findReviewPullRequests('test', 'contributor/project', 'fix/review',
    async () => ({ full_name: 'wrong/project' })), /repository identity/);
  await assert.rejects(() => findReviewPullRequests('test', 'contributor/project', 'fix/review',
    async () => ({ full_name: 'contributor/project', fork: true })), /fork parent/);
  const current = { state: 'OPEN', headRefName: 'fix/review',
    headRepository: { nameWithOwner: 'contributor/project' } };
  assert.equal(matchesReviewHead(current, 'fix/review', 'contributor/project'), true);
  assert.equal(matchesReviewHead(current, 'fix/review', 'other/project'), false);
  assert.equal(matchesReviewHead(current, 'other-branch', 'contributor/project'), false);
  assert.equal(matchesReviewHead({ ...current, state: 'CLOSED' }, 'fix/review', 'contributor/project'), false);
  assert.equal(reviewSelection([
    { id: 'a', isResolved: false, viewerCanReply: true, viewerCanResolve: true, path: 'src/a.js', comments: { nodes: [{ body: 'fix' }] } },
    { id: 'b', isResolved: true, viewerCanReply: true, viewerCanResolve: true, path: 'src/a.js', comments: { nodes: [{ body: 'done' }] } },
    { id: 'c', isResolved: false, viewerCanReply: true, viewerCanResolve: false, path: 'src/a.js', comments: { nodes: [{ body: 'forbidden' }] } }
  ]).length, 1);
  assert.deepEqual(parseAssessment('{"resolved":true,"explanation":"Null input now returns early."}'),
    { resolved: true, explanation: 'Null input now returns early.' });
  assert.throws(() => parseAssessment('{"resolved":"yes","explanation":"Maybe"}'));
  const sha = 'b'.repeat(40), before = 'a'.repeat(40);
  const job = {
    root: '/repo', remote: 'origin', branch: 'fix/review', before,
    repo: 'pony-factor/sweetiebot-SCM', number: 42,
    path: 'src/a.js', threadId: 'THREAD42', comment: 'Handle null'
  };
  const calls = [];
  const fake = async (_root, ...args) => {
    calls.push(args);
    if (args[0] === 'symbolic-ref') return job.branch;
    if (args[0] === 'rev-parse') return sha;
    if (args[0] === 'rev-list') return '1';
    if (args[0] === 'ls-remote') return sha + '\trefs/heads/' + job.branch;
    if (args[0] === 'diff' && args.includes('--name-only')) return job.path;
    return 'diff --git a/src/a.js b/src/a.js\n+if (!value) return;';
  };
  const result = await checkPublished(job, fake);
  assert.equal(result.sha, sha);
  assert.match(result.patch, /return/);
  assert.equal(calls.at(-1)[0], 'diff');
  assert.match(replyBody(job, sha, 'Null input now returns early.'), /sweetiebot-ai-review:THREAD42/);
  const notPushed = await checkPublished(job, async (root, ...args) =>
    args[0] === 'ls-remote' ? before + '\trefs/heads/fix/review' : fake(root, ...args));
  assert.equal(notPushed, null, 'do not respond before push');
  await assert.rejects(() => checkPublished(job, async (root, ...args) =>
    args[0] === 'rev-list' ? '2' : fake(root, ...args)), /More than one commit/);
  await assert.rejects(() => checkPublished(job, async (root, ...args) =>
    args[0] === 'diff' && args.includes('--name-only') ? 'src/other.js' : fake(root, ...args)),
  /does not change the file/);
  console.log('AI review reply safeguards OK');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
