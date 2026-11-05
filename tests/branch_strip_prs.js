'use strict';

const assert = require('node:assert/strict');
const { pullRequestNames } = require('../extension/branches/strip');

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
  console.log('branch strip paginated PR lookup tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
