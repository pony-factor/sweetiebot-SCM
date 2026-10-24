'use strict';
const assert = require('node:assert/strict');
const { integrationSummary, appendMergeSummary, publishIntegrationSummary } = require('../efs/merge_summary');
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
(async () => {
  const { readMergeChecks } = require('../efs/merge_checks');
  const evidence = await readMergeChecks(async endpoint => endpoint.includes('/check-runs?')
    ? { check_runs: [{ name: 'unit tests', status: 'completed', conclusion: 'failure' }] }
    : endpoint.includes('/check-suites?') ? { check_suites: [] } : { statuses: [] },
    'owner/repo', a, { collectEvidence: true });
  assert.equal(evidence.state, 'failed');
  assert.deepEqual(evidence.evidence, [{ name: 'unit tests', result: 'failure' }]);
  const result = { merged: true, sha: c, headSha: b,
    checks: { state: 'passed', hasChecks: true, evidence: [{ name: 'GitHub pull requests', result: 'success' }] } };
  const summary = integrationSummary('owner/repo', 438,
    { headSha: a, explanation: 'Load the real warning preference helper in the isolated test harness.' }, result);
  assert(summary.includes('GitHub pull requests: success'));
  assert(summary.includes('Merge confirmed.'));
  for (const ref of ['pull/438', 'commit/' + a, 'commit/' + b, 'commit/' + c]) assert.equal(summary.split(ref).length, 2);
  const message = appendMergeSummary('Original changes\n\n__________\n\nCo-authored-by: Codex Web <noreply@openai.com>', summary);
  assert(message.indexOf(summary) < message.indexOf('__________'), 'Keep authorship trailers last');
  const pending = integrationSummary('owner/repo', 438, { headSha: a }, { status: 'synced', sha: b });
  assert(pending.includes('Checks were not evaluated'));
  assert(!pending.includes('Merge confirmed'));
  assert(!pending.includes('tests passed'));
  const calls = []; let comments = [], fresh = { merged: true, merge_commit_sha: c, head: { sha: b } };
  const api = async (endpoint, method = 'GET', fields) => {
    calls.push({endpoint, method, fields});
    if (endpoint === 'user') return { login: 'human' };
    if (endpoint.includes('/comments?')) return comments;
    if (endpoint.endsWith('/pulls/438')) return fresh;
    return {};
  };
  await publishIntegrationSummary(api, 'owner/repo', 438, b, result, summary);
  assert.equal(calls.at(-1).method, 'POST');
  comments = [{ id: 1, user: { login: 'another-human' }, body: summary },
    { id: 2, user: { login: 'human' }, body: '<!-- sweetiebot-merge-summary -->\nPrevious attempt' }];
  await publishIntegrationSummary(api, 'owner/repo', 438, b, result, summary);
  assert.equal(calls.at(-1).endpoint, 'repos/owner/repo/issues/comments/2');
  assert.equal(calls.at(-1).method, 'PATCH');
  comments[1].body = summary;
  const writes = () => calls.filter(call => call.method !== 'GET').length;
  const before = writes();
  await publishIntegrationSummary(api, 'owner/repo', 438, b, result, summary);
  assert.equal(writes(), before, 'A replay does not duplicate an unchanged summary');
  fresh = { ...fresh, head: { sha: a } };
  await assert.rejects(publishIntegrationSummary(api, 'owner/repo', 438, b, result, summary), /PR changed/);
  assert.equal(writes(), before, 'Stale heads cannot publish a misleading summary');
  console.log('Factual integration summaries, check evidence, merge trailers, ownership, deduplication and stale-head guards passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
