'use strict';

const assert = require('node:assert/strict');
const { pullRequestNames, cachedPullRequestLookup } = require('../../extension/branches/strip');

const pr = number => ({ number, headRefName: `topic-${number}`, isCrossRepository: false,
  url: `https://github.com/example/repo/pull/${number}`, state: 'MERGED',
  updatedAt: '2026-11-05T00:00:00Z' });
const page = (nodes, hasNextPage) => ({ data: { repository: { pullRequests: {
  nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null }
} } } });

(async () => {
  const pages = Array.from({ length: 6 }, (_, index) => page(
    Array.from({ length: 100 }, (_, offset) => pr(index * 100 + offset + 1)), index < 5));
  pages[5].data.repository.pullRequests.nodes.push({ ...pr(700), headRefName: 'topic-1',
    updatedAt: '2026-11-06T00:00:00Z', state: 'OPEN' },
    { ...pr(800), headRefName: 'foreign', isCrossRepository: true });
  let calls = 0;
  const execute = async (command, args) => {
    calls++;
    assert(args.includes('--paginate'));
    assert(args.includes('--slurp'));
    assert(args.includes('owner=example'));
    assert(args.includes('name=repo'));
    return { stdout: JSON.stringify(pages) };
  };
  const result = await pullRequestNames('complete', 'https://github.com/example/repo.git', execute);
  assert.equal(result.size, 600);
  assert.equal(result.get('topic-600').number, 600, 'Keep PRs beyond the old cap');
  assert.equal(result.get('topic-1').number, 700, 'Prefer the latest PR for reused branches');
  assert.equal(result.get('topic-1').state, 'OPEN');
  assert(!result.has('foreign'));
  await pullRequestNames('complete', 'https://github.com/example/repo.git', execute);
  assert.equal(calls, 1, 'Cache complete results');
  for (const [label, payload] of [
    ['truncated', [page([pr(1)], true)]],
    ['failed', [{ errors: [{ message: 'Unavailable' }] }]],
    ['missing', []]
  ]) {
    assert.equal(await pullRequestNames(label, 'https://github.com/example/repo',
      async () => ({ stdout: JSON.stringify(payload) })), null,
    'Never infer no PR from incomplete responses');
  }
  assert.equal(await pullRequestNames('offline', 'https://github.com/example/repo',
    async () => { throw new Error('offline'); }), null);
  // A cache key shared by two linked worktrees must also coalesce in-flight
  // requests, without making stale or failed metadata persist indefinitely.
  let hits = 0;
  let resume;
  let clock = 1000;
  const key = 'branch-strip-cache-test-repository';
  const gate = new Promise(resolve => { resume = resolve; });
  const lookup = () => cachedPullRequestLookup(key, async () => {
    hits++;
    return gate;
  }, () => clock);
  const first = lookup();
  const second = lookup();
  assert.equal(hits, 1, 'Coalesce concurrent worktree PR lookups');
  resume(new Map([['topic', { number: 650 }]]));
  const [cachedA, cachedB] = await Promise.all([first, second]);
  assert.equal(cachedA, cachedB);
  assert.equal((await lookup()).get('topic').number, 650);
  assert.equal(hits, 1, 'Retain cached PRs until expiration');
  clock += 30001;
  assert.equal((await cachedPullRequestLookup(key, async () => {
    hits++;
    return new Map([['topic', { number: 651 }]]);
  }, () => clock)).get('topic').number, 651);
  assert.equal(hits, 2, 'Refresh expired PR association');
  let unknownCount = 0;
  const unknown = () => cachedPullRequestLookup(key + '-unknown', async () => {
    unknownCount++;
    return null;
  }, () => clock);
  assert.equal(await unknown(), null);
  assert.equal(await unknown(), null);
  assert.equal(unknownCount, 1, 'Cache unavailable PR data briefly, not as no PR');
  await assert.rejects(cachedPullRequestLookup(key + '-failed', async () => {
    throw Error('failed request');
  }, () => clock), /failed request/);
  assert.equal(await cachedPullRequestLookup(key + '-failed', async () => 42, () => clock), 42,
    'Do not retain failed in-flight requests');
  console.log('branch strip paginated PR lookup and shared-cache tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
