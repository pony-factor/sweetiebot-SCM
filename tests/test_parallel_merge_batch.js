'use strict';
const assert = require('node:assert/strict');
const moduleRoot = require('node:path').resolve(__dirname, process.env.LINDSEY_MODULE_ROOT || '../efs');
const { planMergeLanes, createParallelMergeBatch } = require(moduleRoot + '/parallel_merge_batch');
const head = 'a'.repeat(40), initialBase = 'b'.repeat(40), nextBase = 'c'.repeat(40);
const selection = { repository: 'owner/repo', pullRequests: Array.from({ length: 12 }, (_, index) => ({
  number: index + 1, title: 'Feature ' + (index + 1), url: 'https://github.com/owner/repo/pull/' + (index + 1),
  head: 'feature-' + (index + 1), headSha: head, base: 'main'
})) };
const files = new Map(selection.pullRequests.map(pr => [pr.number, ['file-' + pr.number + '.js']]));
const input = (number, baseSha, patch = null) => ({ version: 1, repository: selection.repository,
  results: [{ number, headSha: head, baseSha, patch, explanation: 'Preserve the selected feature.' }] });
async function submit(url, body) {
  const callback = new URLSearchParams(new URL(url).hash.slice(1)).get('return_to');
  const response = await fetch(callback, { method: 'POST', headers: {
    Origin: new URL(callback).origin, 'Content-Type': 'application/json'
  }, body: JSON.stringify(body) });
  return { status: response.status, result: await response.json() };
}

(async () => {
  const plan = planMergeLanes(selection, files);
  assert.deepEqual(plan.map(lane => lane.pullRequests.map(pr => pr.number)), [[1, 4, 7, 10], [11, 8, 5, 2], [9, 3, 6, 12]]);
  assert.equal(new Set(plan.flatMap(lane => lane.pullRequests.map(pr => pr.number))).size, 12);
  const overlap = new Map(files);
  overlap.set(2, ['file-1.js']);
  const stack = { ...selection, pullRequests: selection.pullRequests.map(pr =>
    pr.number === 3 ? { ...pr, base: 'feature-1' } : pr) };
  const grouped = planMergeLanes(stack, overlap);
  const parentLane = grouped.find(lane => lane.pullRequests.some(pr => pr.number === 1));
  assert.equal(grouped.length, 3, 'Shared files do not collapse independent review sessions');
  assert(parentLane.pullRequests.some(pr => pr.number === 3), 'Stacks stay with their parent');
  assert(parentLane.pullRequests.findIndex(pr => pr.number === 1) < parentLane.pullRequests.findIndex(pr => pr.number === 3));
  const reversedStack = planMergeLanes({ ...stack, pullRequests: [...stack.pullRequests].reverse() }, overlap)
    .find(lane => lane.pullRequests.some(pr => pr.number === 1));
  assert(reversedStack.pullRequests.findIndex(pr => pr.number === 1) < reversedStack.pullRequests.findIndex(pr => pr.number === 3));
  assert.equal(planMergeLanes(selection, new Map()).length, 1, 'Unknown file ownership falls back to one session');

  for (const count of [8, 9, 10, 11, 12]) {
    const subset = { ...selection, pullRequests: selection.pullRequests.slice(0, count) };
    const shared = new Map(subset.pullRequests.map(pr => [pr.number, ['shared.js']]));
    const balanced = planMergeLanes(subset, shared);
    assert.equal(balanced.length, count > 10 ? 3 : 2, 'Middle starts only above ten PRs');
    const sizes = balanced.map(lane => lane.pullRequests.length);
    assert(Math.max(...sizes) - Math.min(...sizes) <= 1, 'Overlapping files distribute evenly');
    assert.equal(new Set(balanced.flatMap(lane => lane.pullRequests.map(pr => pr.number))).size, count);
  }

  let base = initialBase, active = 0, maximumActive = 0, release, started;
  const startedFirst = new Promise(resolve => { started = resolve; });
  const firstGate = new Promise(resolve => { release = resolve; });
  const merged = new Set(), executions = [], states = [];
  const api = async endpoint => {
    if (endpoint.includes('/branches/')) return { commit: { sha: base } };
    const number = Number(endpoint.match(/\/pulls\/(\d+)/)?.[1]);
    const pr = selection.pullRequests.find(pr => pr.number === number);
    assert(pr, endpoint);
    if (endpoint.includes('/files?')) return files.get(number).map(filename => ({ filename }));
    return { state: merged.has(number) ? 'closed' : 'open', merged: merged.has(number), draft: false,
      title: pr.title, head: { ref: pr.head, sha: head, repo: { full_name: selection.repository } }, base: { ref: pr.base } };
  };
  const batch = await createParallelMergeBatch(selection, { api, destination: 'https://chatgpt.com/',
    onState: async state => { states.push(state); }, execute: async body => {
      const number = body.results[0].number;
      executions.push(number); active++; maximumActive = Math.max(maximumActive, active);
      if (number === 1) { started(); await firstGate; }
      merged.add(number); base = nextBase; active--;
      return { repository: selection.repository, results: [{ number, status: 'merged', merged: true, sha: base }],
        summaryErrors: [{ number, error: 'Optional summary unavailable' }] };
    } });
  try {
    assert.equal(batch.launches.length, 3);
    const [oldest, newest, middle] = batch.launches;
    const wrongLane = await submit(newest.url, input(1, initialBase));
    assert.equal(wrongLane.status, 400, 'A review tab cannot apply a PR owned by another tab');
    assert.deepEqual(executions, []);
    const first = submit(oldest.url, input(1, initialBase));
    await startedFirst;
    const stale = submit(newest.url, input(11, initialBase, 'Complete resolution patch\n'));
    const independent = submit(middle.url, input(9, initialBase));
    release();
    const [a, b, c] = await Promise.all([first, stale, independent]);
    assert.equal(maximumActive, 1, 'Parallel GPT reviews never apply concurrently');
    assert.equal(a.result.results[0].merged, true);
    assert.equal(a.result.summaryErrors[0].number, 1);
    assert.equal(b.result.results[0].status, 'needs_refresh', 'An old-base patch never reaches the executor');
    assert(b.result.continueUrl);
    assert.equal(c.result.results[0].merged, true, 'Unrelated review sessions keep progressing');
    assert.deepEqual(executions, [1, 9]);
    assert.equal(batch.state().merged.length, 2);
    assert.equal(batch.state().workers.length, 3);
    assert(states.some(state => state.workers.some(worker => worker.phase === 'Applying')));
    let continuation = b.result.continueUrl;
    for (let index = 0; index < 3; index++) {
      const refreshed = await submit(continuation, input(11, initialBase, 'Complete resolution patch\n'));
      assert.equal(refreshed.result.results[0].status, 'needs_refresh');
      assert(refreshed.result.continueUrl, 'An unapplied old-base patch does not exhaust actual integration attempts');
      continuation = refreshed.result.continueUrl;
    }
    const recovered = await submit(continuation, input(11, nextBase));
    assert.equal(recovered.result.results[0].merged, true);
    await submit(oldest.url, input(1, initialBase));
    assert.equal(executions.filter(number => number === 1).length, 1, 'Old handoffs remain one-use');
  } finally { release(); batch.dispose(); }

  // Missing filename access must still launch a valid ordinary sequential batch.
  const fallback = await createParallelMergeBatch(selection, { destination: 'https://chatgpt.com/',
    api: endpoint => endpoint.includes('/files?') ? Promise.reject(Error('Unavailable filenames')) : api(endpoint),
    execute: async () => assert.fail('No execution during queue planning') });
  try { assert(fallback.url); assert.equal(fallback.launches, undefined); }
  finally { fallback.dispose(); }

  merged.clear(); base = initialBase;
  let limited = false;
  const paused = await createParallelMergeBatch(selection, { destination: 'https://chatgpt.com/',
    api: async endpoint => {
      if (limited && endpoint === 'repos/owner/repo/pulls/1') throw Object.assign(Error('Rate limit reached'), {
        rateLimited: true, retryAt: Date.now() + 60000, configured: true
      });
      return api(endpoint);
    },
    execute: async () => assert.fail('A rate-limited review lane must not apply') });
  try {
    limited = true;
    const first = await submit(paused.launches[0].url, input(1, initialBase));
    assert.equal(first.result.results[0].rateLimited, true);
    const other = await submit(paused.launches[1].url, input(11, initialBase));
    assert.equal(other.result.results[0].rateLimited, true, 'A shared rate limit pauses every apply lane');
    assert.equal(other.result.continueUrl, undefined);
    assert(paused.state().rateLimit);
  } finally { paused.dispose(); }
  console.log('Parallel review ownership, stack/file grouping, serialization, stale-base refresh and replay checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
