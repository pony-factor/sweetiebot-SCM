'use strict';
const assert = require('node:assert/strict');
const { readPushedPR } = require('../extension/github/pushed_pr');

(async () => {
  const old = 'a'.repeat(40), preparedSha = 'b'.repeat(40), other = 'c'.repeat(40);
  const original = { state: 'open', title: 'Selected PR',
    head: { ref: 'selected', sha: old, repo: { full_name: 'owner/repo' } },
    base: { ref: 'main', repo: { full_name: 'owner/repo' } } };
  const pushed = { ...original, head: { ...original.head, sha: preparedSha } };
  const attempt = async (snapshots, remote = preparedSha) => {
    let reads = 0, headReads = 0;
    const waits = [];
    const result = readPushedPR({ original, preparedSha,
      readPR: async () => snapshots[Math.min(reads++, snapshots.length - 1)],
      readHead: async () => { headReads++; return remote; },
      sleep: async delay => { waits.push(delay); }
    });
    return { result, waits, reads: () => reads, headReads: () => headReads };
  };
  const stale = await attempt([original, original, pushed]);
  assert.equal(await stale.result, pushed);
  assert.deepEqual(stale.waits, [200, 500]);
  assert.equal(stale.headReads(), 3, 'Verify the selected remote head on every retry');
  const expired = await attempt([original]);
  await assert.rejects(expired.result, /not confirmed/);
  assert.equal(expired.reads(), 5, 'Stale metadata has a bounded retry window');
  for (const pr of [
    { ...pushed, state: 'closed' }, { ...pushed, draft: true },
    { ...pushed, merged_at: 'now' }, { ...pushed, stack: {} },
    { ...pushed, title: 'Renamed' },
    { ...pushed, head: { ...pushed.head, ref: 'another' } },
    { ...pushed, head: { ...pushed.head, sha: other } },
    { ...pushed, head: { ...pushed.head, repo: { full_name: 'fork/repo' } } },
    { ...pushed, base: { ...pushed.base, ref: 'release' } },
    { ...pushed, base: { ...pushed.base, repo: { full_name: 'another/repo' } } }
  ]) {
    const changed = await attempt([pr, pushed]);
    await assert.rejects(changed.result, /PR changed/);
    assert.equal(changed.reads(), 1, 'Actual PR changes must never be retried');
    assert.deepEqual(changed.waits, []);
  }
  for (const snapshot of [original, pushed]) {
    const moved = await attempt([snapshot, pushed], other);
    await assert.rejects(moved.result, /PR changed/);
    assert.equal(moved.reads(), 1, 'A different remote head stops immediately');
  }
  const unavailable = readPushedPR({ original, preparedSha, readPR: async () => original,
    readHead: async () => { throw Error('Remote unavailable'); } });
  await assert.rejects(unavailable, /Remote unavailable/);
  console.log('Post-push PR verification retries stale metadata and rejects changed identities or remote heads.');
})().catch(error => { console.error(error); process.exitCode = 1; });
