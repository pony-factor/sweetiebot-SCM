'use strict';
const assert = require('node:assert/strict');
const { createMergeBatch } = require('../efs/merge_batch');
const { readMergeChecks, waitForMergeChecks } = require('../efs/merge_checks');
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40), e = 'e'.repeat(40);
const selection = { repository: 'owner/repo', pullRequests: [1, 2].map(number => ({ number,
  title: 'Feature ' + number, url: 'https://github.com/owner/repo/pull/' + number,
  head: 'feature-' + number, headSha: number === 1 ? a : b, base: 'main' })) };

async function submit(url, results, deferred) {
  const target = new URL(url);
  const launch = new URLSearchParams(target.hash.slice(1));
  const callback = launch.get('return_to') || url;
  const response = await fetch(callback, { method: 'POST',
    headers: { Origin: new URL(callback).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, repository: 'owner/repo', results, ...(deferred ? { deferred } : {}) }) });
  return { status: response.status, value: await response.json() };
}
const item = (number, baseSha, patch = null, headSha = number === 1 ? a : b) => ({ number,
  headSha, baseSha, patch, explanation: number === 1 ? 'Preserve the main calculation fix.' : 'Add the optional feature without undoing the calculation fix.' });

(async () => {
  let base = c, calls = 0, secondAttempt = 0;
  const prs = new Map(selection.pullRequests.map(pr => [pr.number, { ...pr }]));
  const api = async endpoint => {
    if (endpoint.includes('/branches/')) return { commit: { sha: base } };
    const number = Number(endpoint.split('/').at(-1)), pr = prs.get(number);
    assert(pr);
    return { number, state: 'open', draft: false, title: pr.title,
      mergeable: number !== 2 || base === c, head: { ref: pr.head, sha: pr.headSha, repo: { full_name: 'owner/repo' } },
      base: { ref: pr.base } };
  };
  const batch = await createMergeBatch(selection, { api, destination: 'https://chatgpt.com/', execute: async input => {
    calls++;
    const selected = input.results[0];
    if (!selected) return { repository: 'owner/repo', results: [] };
    if (selected.number === 1) { base = d; return { repository: 'owner/repo', results: [{ number: 1,
      status: 'merged', merged: true, sha: d, headSha: a, previousHeadSha: a }] }; }
    secondAttempt++;
    assert.equal(selected.baseSha, d, 'Later work uses the base that actually merged');
    return { repository: 'owner/repo', results: [{ number: 2, merged: secondAttempt > 1,
      status: secondAttempt === 1 ? 'needs_resolution' : 'merged', sha: e,
      conflictPaths: secondAttempt === 1 ? ['price.js'] : [], baseSha: d }] };
  } });
  try {
    const tooMany = await submit(batch.url, [item(1, c), item(2, c)]);
    assert.equal(tooMany.status, 400);
    assert.equal(calls, 0, 'Do not prepare stale multi-PR patches in one round');
    const first = await submit(batch.url, [item(1, c)]);
    assert.equal(first.value.batch.merged.length, 1);
    let prompt = new URLSearchParams(new URL(first.value.continueUrl).hash.slice(1)).get('q');
    assert(prompt.includes('Preserve the main calculation fix.'));
    assert(prompt.includes('"baseAdvancedByEarlierWork":true'));
    assert(prompt.includes('"initiallyMergeable":true'));
    const conflict = await submit(first.value.continueUrl, [item(2, d)]);
    prompt = new URLSearchParams(new URL(conflict.value.continueUrl).hash.slice(1)).get('q');
    assert(prompt.includes('price.js'));
    assert(prompt.includes('needs_resolution'));
    assert.equal(conflict.value.batch.deferred.length, 0, 'A routine overlap does not request human input');
    const resolved = await submit(conflict.value.continueUrl, [item(2, d, 'complete current-base patch\n')]);
    assert.equal(resolved.value.batch.merged.length, 2);
    assert.equal(resolved.value.continueUrl, undefined);
    await submit(batch.url, [item(1, c)]);
    assert.equal(calls, 3, 'Replaying an earlier round cannot execute it twice');
  } finally { batch.dispose(); }

  // A prepared head is accepted only as a result of our own local executor.
  const one = { ...selection, pullRequests: [selection.pullRequests[0]] };
  let currentHead = a, attempts = 0;
  const ownApi = async endpoint => endpoint.includes('/branches/') ? { commit: { sha: c } } : {
    state: 'open', draft: false, title: 'Feature 1', head: { ref: 'feature-1', sha: currentHead,
      repo: { full_name: 'owner/repo' } }, base: { ref: 'main' } };
  const own = await createMergeBatch(one, { api: ownApi, destination: 'https://chatgpt.com/', execute: async () => {
    attempts++; currentHead = e;
    return { repository: 'owner/repo', results: [{ number: 1, status: attempts === 1 ? 'waiting' : 'merged',
      merged: attempts > 1, sha: e, previousHeadSha: attempts === 1 ? a : e }] };
  } });
  try {
    const prepared = await submit(own.url, [item(1, c)]);
    assert(prepared.value.continueUrl);
    const finished = await submit(prepared.value.continueUrl, [item(1, c, null, e)]);
    assert.equal(finished.value.batch.merged.length, 1);
  } finally { own.dispose(); }

  let checks = { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }],
    check_suites: [], statuses: [] };
  const checkApi = async endpoint => endpoint.includes('/check-runs?') ? { check_runs: checks.check_runs }
    : endpoint.includes('/check-suites?') ? { check_suites: checks.check_suites } : { statuses: checks.statuses };
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'failed');
  checks.check_runs.push({ id: 2, name: 'test', status: 'completed', conclusion: 'success' });
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'passed', 'A successful rerun supersedes an old failure');
  checks.check_runs = [];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a, { expectChecks: true })).state, 'pending');
  assert.equal((await waitForMergeChecks(checkApi, 'owner/repo', a, { expectChecks: true, timeoutMs: 0 })).state, 'pending');
  checks.check_runs = [{ name: 'test', status: 'queued' }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'pending');
  checks.check_runs[0] = { name: 'test', status: 'completed', conclusion: 'success' };
  checks.check_suites = [{ status: 'in_progress' }];
  assert.equal((await readMergeChecks(checkApi, 'owner/repo', a)).state, 'pending', 'Wait for the full suite, not only its first finished job');
  console.log('Sequential merge continuation, intent ledger, current-base resolution, replay and integrated-head check gates passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
