'use strict';
const assert = require('node:assert/strict');
const { publishMergeSummaries, MARKER } = require('../efs/merge_summary');
const sha = 'a'.repeat(40);
const selection = { repository: 'owner/repo', pullRequests: [{ number: 12, title: '✨ Add optional tax', url: 'https://github.com/owner/repo/pull/12', base: 'main', head: 'feature' }] };
const input = { results: [{ number: 12, explanation: 'Add an optional tax parameter while retaining the corrected multiplier.' }] };
const result = { results: [{ number: 12, merged: true, status: 'merged', sha }] };

(async () => {
  const options = { selection, input, result, token: 'test-token' };
  const { batchMergePrompt } = require('../efs/pull_request_batch');
  const promptOptions = { repositoryUrl: 'https://github.com/owner/repo', pullRequests: selection.pullRequests, localHandoff: true };
  assert(!batchMergePrompt(promptOptions).includes('OPTIONAL GITHUB SUMMARY ENABLED'));
  assert(batchMergePrompt(promptOptions).includes('OPTIONAL GITHUB STATUS UPDATES DISABLED'));
  const statusPrompt = batchMergePrompt({ ...promptOptions, postStatusUpdates: true });
  assert(statusPrompt.includes('OPTIONAL GITHUB STATUS UPDATES ENABLED'));
  assert(!statusPrompt.includes('OPTIONAL GITHUB SUMMARY ENABLED'));
  assert(batchMergePrompt({ ...promptOptions, postMergeSummaries: true }).includes('OPTIONAL GITHUB STATUS UPDATES DISABLED'));
  assert(batchMergePrompt({ ...promptOptions, postMergeSummaries: true }).includes('concise standalone summary'));

  await publishMergeSummaries({ ...options, enabled: false,
    identity: () => assert.fail('Disabled summaries must not authenticate') });
  await publishMergeSummaries({ ...options, enabled: true,
    result: { results: [{ number: 12, status: 'synced', merged: false }] },
    identity: () => assert.fail('Preparation must never publish a merge summary') });
  let comments = [], confirmed = true, failWrites = false;
  const writes = [];
  const fetchImpl = async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer test-token');
    if (request.method !== 'GET') {
      if (failWrites) return { ok: false, status: 403 };
      const body = JSON.parse(request.body).body;
      writes.push({ url, method: request.method, body });
      comments = [{ id: 44, user: { login: 'test-user' }, body }];
      return { ok: true, json: async () => ({ id: 44 }) };
    }
    return { ok: true, json: async () => url.endsWith('/pulls/12')
      ? { merged: confirmed, merge_commit_sha: sha, base: { ref: 'main' }, head: { ref: 'feature' } }
      : comments };
  };
  const run = () => publishMergeSummaries({ ...options, enabled: true, fetchImpl,
    identity: async () => ({ token: 'test-token', login: 'test-user' }) });
  assert.deepEqual(await run(), []);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert(writes[0].body.startsWith(MARKER));
  assert(writes[0].body.includes(input.results[0].explanation));
  assert.deepEqual(await run(), []);
  assert.equal(writes.length, 1, 'A replay must not create another comment');
  input.results[0].explanation = 'Clarified summary of the optional tax parameter.';
  assert.deepEqual(await run(), []);
  assert.equal(writes[1].method, 'PATCH');
  assert(writes[1].url.endsWith('/issues/comments/44'));
  comments = [{ id: 55, user: { login: 'another-user' }, body: MARKER + '\nTheir summary' }];
  assert.deepEqual(await run(), []);
  assert.equal(writes.at(-1).method, 'POST', 'Never overwrite another author’s comment');
  confirmed = false;
  const count = writes.length;
  assert.match((await run())[0].error, /not confirmed/);
  assert.equal(writes.length, count, 'GitHub must independently confirm the exact merge before publication');
  confirmed = true; failWrites = true; comments = [];
  assert.match((await run())[0].error, /HTTP 403/);
  assert.equal(result.results[0].merged, true, 'Summary failures do not invalidate a verified merge');
  console.log('Opt-in summary gates, verified merge checks, deduplication and publication failures passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
