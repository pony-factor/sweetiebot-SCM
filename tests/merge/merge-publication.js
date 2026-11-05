'use strict';
const assert = require('node:assert/strict');
const { createPublicationQueue } = require('../../extension/merge/publication-queue');
const { lindseyAPI } = require('../../extension/github/lindsey-api');
const { batchMergePrompt } = require('../../extension/github/pull-request-batch');
const { reportOptionsInstructions, blockerPrompt } = require('../../extension/merge/blocker-actions');
(async () => {
  const preferences = {};
  const vscode = { workspace: { getConfiguration: () => ({ get: key => preferences[key] }) } };
  const selection = { repository: 'o/r', pullRequests: [{ number: 1 }] };
  const input = { results: [{ number: 1, explanation: 'Preserve both features.', decisions: [{ path: 'a.js' }] }] };
  const writes = [];
  const publisher = async args => { writes.push(args); return []; };
  const queue = createPublicationQueue(vscode, selection, { publish: publisher });
  const prepared = { number: 1, status: 'waiting', sha: 'b'.repeat(40), previousHeadSha: 'a'.repeat(40) };
  await queue.record(selection, input, { results: [prepared] });
  assert.equal(writes.length, 0);
  preferences.mergePostStatusUpdates = true;
  await queue.replay();
  assert.equal(writes.length, 1, 'Enabling posting revisits an already completed integration without restarting');
  assert.equal(writes[0].postStatusUpdates, true);
  preferences.mergePostSummaries = true;
  await queue.record(selection, input, { results: [{ number: 1, status: 'merged', merged: true, sha: 'c'.repeat(40) }] });
  assert.equal(writes.length, 2, 'The merge supersedes the prepared-head update');
  assert.equal(writes[1].enabled, true);
  assert.equal(writes[1].result.results[0].merged, true);
  preferences.mergePostStatusUpdates = false;
  preferences.mergePostSummaries = false;
  await queue.replay();
  assert.equal(writes.length, 2, 'Disabling posting prevents publication');
  const restored = createPublicationQueue(vscode, selection, { publish: publisher,
    history: [{ ...input.results[0], status: 'merged', destinationSha: 'c'.repeat(40) }] });
  preferences.mergePostSummaries = true;
  await restored.replay();
  assert.equal(writes.at(-1).result.results[0].sha, 'c'.repeat(40));

  let authCalls = 0, requests = 0;
  const identity = { separateAppsEnabled: () => false,
    getRoleInstallationToken: async (role, repository) => {
      authCalls++; assert.equal(role, 'lindsey'); assert.equal(repository, 'o/r'); return { token: 'app-test' };
    }, workflowBotLogin: () => 'lindsey[bot]' };
  await assert.rejects(lindseyAPI('o/r', { identity }), /Configure the Lindsey/);
  assert.equal(authCalls, 0, 'No personal account fallback');
  identity.separateAppsEnabled = () => true;
  const actor = await lindseyAPI('o/r', { identity, fetchImpl: async (url, options) => {
    requests++; assert.equal(options.headers.Authorization, 'Bearer app-test');
    assert.equal(url, 'https://api.github.com/repos/o/r/pulls/1/reviews');
    return { ok: true, json: async () => ({ id: 1 }) };
  } });
  assert.equal(actor.login, 'lindsey[bot]');
  await actor.api('repos/o/r/pulls/1/reviews', { method: 'POST', body: { event: 'COMMENT' } });
  await assert.rejects(actor.api('repos/other/repo/pulls/1/reviews'), /outside/);
  await assert.rejects(actor.api('user'), /outside/);
  assert.equal(requests, 1);
  const automatic = reportOptionsInstructions();
  assert(automatic.includes('Never manufacture options for a simple conflict fix'));
  assert(automatic.includes('no personal-account fallback'));
  const prompt = batchMergePrompt({ repositoryUrl: 'https://github.com/o/r',
    pullRequests: [{ number: 1, title: 'Fix behavior', base: 'main', head: 'topic' }], localHandoff: true });
  assert(prompt.includes(automatic));
  const explicit = blockerPrompt('o/r', { number: 1 }, { id: 'chosen', label: 'Chosen repair', prompt: 'Fix the behavior.' });
  assert(explicit.includes('add_review_to_pr or reply_to_review_comment'));
  assert(explicit.includes('never substitute gh, curl, raw HTTP'));
  console.log('Live posting preference replay, Lindsey-only automatic identity and explicit connector routing passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
