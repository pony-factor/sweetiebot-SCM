'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  REPORT_MARKER, REVIEW_MARKER, validateSelection, reportFromComments, normalizeInlineReviewComments,
  mergePhase, normalizeFiles, githubGet, configuredTimelineMode, routineTimelineEvent, startMergeDashboard
} = require('../../extension/merge/dashboard');
const { formatTimelineTimestamp, formatMergeOutcome } = require('../../extension/merge/dashboard-timestamps');
const { renderMergeMarkdown } = require('../../extension/merge/dashboard-markdown');
const { mergeActivityPresentation, renderMergeActivitySummary, mergeActivityElapsed } = require('../../extension/merge/dashboard-activity');
const { classifyMergePatchLine, renderMergePatch } = require('../../extension/merge/dashboard-diff');
const { parseReportOptions, blockerOptions, manualBlockerActions, dashboardActionPlan, blockerPrompt, reportOptionsInstructions } = require('../../extension/merge/blocker-actions');
const { createMergeDashboardPersistence, stateKey } = require('../../extension/merge/dashboard-persistence');
const { allPullRequestsMerged } = require('../../extension/merge/celebration');

(async () => {
  assert.equal(allPullRequestsMerged([]), false, 'An empty batch cannot celebrate');
  assert.equal(allPullRequestsMerged([{state:'merged'}, {state:'merging'}]), false);
  assert.equal(allPullRequestsMerged([{state:'merged'}, {state:'closed'}]), false);
  assert.equal(allPullRequestsMerged([{state:'merged'}, {state:'blocked'}]), false);
  assert.equal(allPullRequestsMerged([{state:'merged'}, {state:'merged'}]), true);
  const sha = 'a'.repeat(40);
  const nextSha = 'b'.repeat(40);
  const waitStart = '2026-10-27T15:00:00Z', waitUpdated = '2026-10-27T15:00:30Z';
  const elapsedAt = Date.parse(waitStart) + 65000;
  assert.equal(mergeActivityElapsed({ at: waitStart, phase: 'reviewing' }, elapsedAt),
    '1m 5s in this step', 'A GPT wait must not invent a last update from its start time');
  assert.equal(mergeActivityElapsed({ at: waitStart, updatedAt: 'not-a-date' }, elapsedAt),
    '1m 5s in this step', 'An invalid last-update value cannot masquerade as progress');
  assert.equal(mergeActivityElapsed({ at: waitStart, updatedAt: waitUpdated }, elapsedAt),
    '1m 5s in this step · last update 35s ago',
    'The two clocks measure independent events');
  const url = 'https://github.com/pony-factor/example/pull/12';
  assert(routineTimelineEvent({ state: 'progress',
    message: 'Refreshing GitHub PR status, checks and review activity' }),
  'Routine polling must not fill the timeline');
  assert(routineTimelineEvent({ state: 'updated', message: 'GitHub status refresh completed' }),
    'Old persisted refresh completions are hidden too');
  assert(routineTimelineEvent({ state: 'progress', message: 'Review round 3 · waiting for GPT to return a current-base handoff' }),
    'Review waits belong in Current activity rather than duplicate history');
  assert(routineTimelineEvent({ state: 'progress', message: 'GitHub checks: pending · 3 checks reported' }),
    'Repeated pending checks belong in the live status');
  assert(!routineTimelineEvent({ state: 'merged', message: 'GitHub merge confirmed' }),
    'A verified merge must stay in history');
  assert(!routineTimelineEvent({ state: 'error', message: 'Fetch failed' }),
    'An actual fetch failure must stay in history');
  assert(!routineTimelineEvent({ state: 'progress', message: 'Prepared commit pushed to the PR branch · not merged' }),
    'A pushed commit is a meaningful milestone');
  assert(!routineTimelineEvent({ state: 'progress',
    message: 'Repair commit verified · retiring stale patches and requesting a fresh review' }),
    'A verified repair must remain visible in timeline history');
  const selection = { repository: 'pony-factor/example',
    pullRequests: [{ number: 12, title: 'Fix a conflict', url,
      head: 'feature', base: 'main', headSha: sha }] };
  assert.deepEqual(validateSelection(selection).pullRequests[0].headSha, sha);
  assert.throws(() => validateSelection({ ...selection, repository: '../../../evil' }), /Invalid/);
  assert.throws(() => validateSelection({ ...selection,
    pullRequests: [...selection.pullRequests, ...selection.pullRequests] }), /duplicate/);
  assert.throws(() => validateSelection({ ...selection, pullRequests: [{
    ...selection.pullRequests[0], url: 'https://evil.invalid/anywhere'
  }] }), /Invalid/);
  const comments = [
    { id: 5, html_url: url + '#comment-5', body: REPORT_MARKER + '\nOld report' },
    { id: 6, html_url: url + '#comment-6', body: REVIEW_MARKER + '\nNeed owner decision' },
    { id: 7, html_url: url + '#comment-7', body: REPORT_MARKER + '\nNew report' },
  ];
  comments.push({id:9,path:'options.js',body:'<!-- sweetiebot-merge-analysis -->\n### Preserve storage keys\nMain and PR add distinct keys; retain both.'});
  const notes = reportFromComments(comments);
  assert.equal(notes.analysis.length,1);
  assert.equal(notes.analysis[0].path,'options.js');
  const optionsBlock = '<!-- sweetiebot-merge-options\n' + JSON.stringify({ version: 1, options: [
    { id: 'preserve-api', label: 'Keep the current API', description: 'Add compatibility for the PR.', prompt: 'Preserve the current API and add the proposed compatibility layer.', engine: 'shell' },
    { id: 'replace-api', label: 'Adopt the new API', prompt: 'Update callers to the new interface.' },
    { id: '../../unsafe', label: 'Bad', prompt: 'bad' },
    { id: 'invalid', label: 'Empty prompt', prompt: '' }
  ] }) + '\n-->';
  const parsedOptions = parseReportOptions(optionsBlock);
  assert.equal(parsedOptions.length, 2);
  assert.equal(parsedOptions[0].engine, undefined, 'Report content cannot select an execution engine');
  const actionable = reportFromComments([{ id: 8, body: REPORT_MARKER + '\nKeep main.\n' + optionsBlock }]);
  assert.equal(actionable.report.text, 'Keep main.', 'Machine-readable choices are not rendered as report text');
  const choices = blockerOptions({ state: 'blocked', report: actionable.report });
  assert.equal(choices[0].id, 'report-preserve-api');
  assert.equal(choices.length, 2, 'Only real competing implementations are selectable');
  const singleBlock = '<!-- sweetiebot-merge-options\n' + JSON.stringify({ version: 1, options: [{ id: 'apply-file-plan', label: 'Apply the plan', prompt: 'Keep the independent additions.' }] }) + '\n-->';
  assert.deepEqual(parseReportOptions(singleBlock), [], 'Legacy one-choice prompts are ignored');
  assert.deepEqual(blockerOptions({state:'conflict',localReview:{options:[parsedOptions[0]]}}), [], 'Local single choices are also suppressed');
  assert.deepEqual(blockerOptions({ state: 'conflict', localReview: { options: [{ id: 'preserve-both' }, { id: 'report-review-first' }] } }), [], 'Legacy generic recovery prompts are removed');
  assert(choices.some(option => option.id === 'report-preserve-api'));
  const recommendation = parseReportOptions('<!-- sweetiebot-merge-options\n' + JSON.stringify({ version: 1, options: [
    { id: 'compatibility', label: 'Add a compatibility layer', prompt: 'Keep both interfaces with an adapter.', recommended: true },
    { id: 'replace-api', label: 'Replace the API', prompt: 'Adopt the proposed API.', recommended: true }
  ] }) + '\n-->');
  assert.equal(recommendation.filter(option => option.recommended).length, 1);
  const recommendedChoices = blockerOptions({ state: 'review', review: { options: recommendation } });
  assert.equal(recommendedChoices[0].id, 'report-compatibility', 'The specific recommendation precedes generic recovery actions');
  assert(!recommendedChoices.some(option => option.engine === 'shell'), 'Recommendation metadata never grants execution privileges');
  assert.deepEqual(blockerOptions({ state: 'merged', report: actionable.report }), []);
  const manual = manualBlockerActions({state:'conflict'});
  assert.equal(manual.length, 7);
  assert(manual.every(action => action.manual && !action.reaction));
  assert.equal(manual.find(action => action.id === 'inspect-codex').engine, 'codex');
  assert.deepEqual(manualBlockerActions({state:'merged'}), []);
  const checksPlan = dashboardActionPlan({ state: 'checks', mergeableState: 'unstable' });
  assert.equal(checksPlan.kind, 'checks');
  assert.deepEqual(dashboardActionPlan({ state: 'checks-pending', mergeableState: 'unstable' }).actions, [],
    'In-progress checks must not offer a premature failing-check repair');
  assert.deepEqual(checksPlan.actions.map(action => action.id), ['fix-checks']);
  assert.equal(checksPlan.workspaceAction.id, 'inspect-codex');
  const conflictPlan = dashboardActionPlan({ state: 'conflict' });
  assert.equal(conflictPlan.kind, 'conflict');
  assert.deepEqual(conflictPlan.actions.map(action => action.id), ['resolve-conflicts-local', 'resolve-conflicts']);
  assert(!conflictPlan.actions.some(action => action.id === 'suggest-options'),
    'There is no separate ask-for-options step');
  const decisionPlan = dashboardActionPlan({ state: 'conflict', report: actionable.report });
  assert.equal(decisionPlan.kind, 'choice');
  assert.deepEqual(decisionPlan.actions.map(action => action.id), choices.map(option => option.id),
    'The current review choices are the implementation buttons');
  assert.deepEqual(dashboardActionPlan({ state: 'updated' }).actions.map(action => action.id), ['resolve-conflicts-local', 'sync-checks']);
  const snapshotPlan = dashboardActionPlan({ state: 'updated', snapshotChanged: true });
  assert.equal(snapshotPlan.kind, 'snapshot');
  assert.deepEqual(snapshotPlan.actions.map(action => action.id), ['resolve-conflicts-local'],
    'A stale batch permits an explicitly selected local repair, while suppressing stale implementation choices');
  assert.equal(snapshotPlan.workspaceAction, null);
  assert.match(snapshotPlan.description, /select it again/);
  assert.equal(dashboardActionPlan({ state: 'blocked', mergeableState: 'blocked' }).actions[0].id, 'investigate-blocker');
  assert.deepEqual(dashboardActionPlan({ state: 'merged' }).actions, []);
  const selectedPrompt = blockerPrompt('pony-factor/example', selection.pullRequests[0], choices[0]);
  assert(selectedPrompt.includes('OPTIONAL GITHUB STATUS UPDATES DISABLED'));
  assert(blockerPrompt('pony-factor/example', selection.pullRequests[0], choices[0], 'web',
    { postStatusUpdates: true }).includes('OPTIONAL GITHUB STATUS UPDATES ENABLED'));
  assert(selectedPrompt.includes('Preserve the current API and add the proposed compatibility layer.'));
  assert(selectedPrompt.includes('does not authorize merging or closing'));
  assert(selectedPrompt.includes('GITHUB REVIEW PUBLICATION POLICY'));
  assert(selectedPrompt.includes('publish zero inline comments'));
  assert(selectedPrompt.includes('one comprehensive GitHub pull request review'));
  assert(selectedPrompt.includes('one short review body summarizing the net changes'));
  assert(selectedPrompt.includes('Do not edit a human-authored comment'));
  assert(!selectedPrompt.includes('When finished, update the existing tagged inline review comment'));
  const conflictPrompt = blockerPrompt('pony-factor/example', selection.pullRequests[0],
    manualBlockerActions({ state: 'conflict' }).find(option => option.id === 'resolve-conflicts'));
  assert(conflictPrompt.includes('Never create a per-file inline comment'));
  assert(conflictPrompt.includes('one explanatory commit per cohesive repair category'));
  assert(conflictPrompt.includes('separate sync commit containing only those changes'));
  assert(conflictPrompt.includes('Do not bury conflict decisions'));
  assert(blockerPrompt('pony-factor/example', selection.pullRequests[0], manual[0], 'codex').includes('REPAIR COMMIT HISTORY'));
  const localOption = manual.find(option => option.id === 'resolve-conflicts-local');
  assert.equal(localOption.engine, 'kefania');
  const localPrompt = blockerPrompt('pony-factor/example', selection.pullRequests[0], localOption, 'kefania');
  assert(localPrompt.includes('LOCAL KEFANIA REPAIR'));
  assert(localPrompt.includes('Use operation:"sync" only'));
  assert(!localPrompt.includes('DIRECT WEB REPAIR'));
  assert(localPrompt.includes('AUTOMATIC LINDSEY PUBLICATION'));
  assert(localPrompt.includes('local Lindsey GitHub App publisher'));
  assert(!localPrompt.includes('never Lindsey or any bot account'),
    'Automatic branch-only repairs must not inherit personal-review authorization');
  assert(localPrompt.includes('AUTOMATIC LINDSEY REVIEW'),
    'Unresolved automatic repair choices go to the local App publisher');
  const alternativesPrompt = blockerPrompt('pony-factor/example', selection.pullRequests[0],
    manualBlockerActions({ state: 'conflict' }).find(option => option.id === 'suggest-options'));
  assert(alternativesPrompt.includes('never invent choices for compatible integrations'));
  assert(selectedPrompt.includes('connected GitHub app authenticated as the user'),
    'ChatGPT implementation responses must use the connected user account');
  assert(selectedPrompt.includes('reply_to_review_comment'),
    'Implementation results must create a new reply to the original inline review');
  assert(selectedPrompt.includes('report the exact limitation locally instead of posting a standalone PR Conversation comment'),
    'Missing inline review support must not produce a standalone conversation comment');
  assert(selectedPrompt.includes('Never call update_review_comment or update_issue_comment'),
    'Prior review comments must be immutable');
  assert(!selectedPrompt.includes('When finished, update the existing tagged inline review comment'),
    'The legacy edit-in-place instruction must not return');
  const decisionInstructions = reportOptionsInstructions();
  assert(decisionInstructions.includes('Automatic reviews belong to the Lindsey GitHub App'),
    'Automatic unresolved decisions use Lindsey, never the personal account');
  const selectedDecisionInstructions = reportOptionsInstructions({ userSelected: true });
  assert(selectedPrompt.includes('add_review_to_pr or reply_to_review_comment'));
  assert(selectedDecisionInstructions.includes('connected user-authenticated GitHub app'));
  assert(selectedDecisionInstructions.includes('new current-head root inline review comment'),
    'New emoji decisions need independent, current-head inline comments');
  assert(selectedDecisionInstructions.includes('publish a new review comment'),
    'Revised decisions cannot overwrite old reaction instructions');
  assert(!decisionInstructions.includes('update the existing tagged comment'),
    'The original Lindsey review is kept as authored');
  const optionRequest = manualBlockerActions({ state: 'conflict' })
    .find(option => option.id === 'suggest-options');
  assert(optionRequest.prompt.includes('NEW current-head root inline review comment'),
    'Asking GPT for options must use the new user-authored review path');
  assert(optionRequest.prompt.includes('never edit existing comments'),
    'Manual decisions must preserve earlier review comments');
  assert.equal(notes.report.text, 'New report');
  assert.equal(notes.review.text, 'Need owner decision');
  const liveDecisions = '<!-- sweetiebot-merge-options\n' + JSON.stringify({
    version: 1, headSha: sha, baseSha: 'c'.repeat(40), options: [
      { id: 'keep-api', label: 'Keep API', prompt: 'Keep the original API.' },
      { id: 'adapt-api', label: 'Use adapter', prompt: 'Introduce an adapter.' }
    ]
  }) + '\n-->';
  const activeReview = { id: 20, body: REVIEW_MARKER + '\nWhich interface?\n' + liveDecisions };
  assert.equal(reportFromComments([comments[1]], { headSha: sha, baseSha: 'c'.repeat(40) }).review, null,
    'A historical marker without live decisions cannot block a merge');
  assert.equal(reportFromComments([activeReview], { headSha: sha, baseSha: 'c'.repeat(40) }).review.id, 20);
  assert.equal(reportFromComments([activeReview], { headSha: nextSha, baseSha: 'c'.repeat(40) }).review, null,
    'A new PR head invalidates decisions for its earlier revision');
  assert.equal(reportFromComments([activeReview], { headSha: sha, baseSha: 'd'.repeat(40) }).review, null,
    'A new PR base invalidates historical decisions');
  assert.equal(reportFromComments([{ ...activeReview, body: activeReview.body +
    '\n<!-- sweetiebot-merge-review-resolved -->' }],
    { headSha: sha, baseSha: 'c'.repeat(40) }).review, null,
    'Explicitly resolved decisions cannot block later polls');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'clean' },
    { review: { id: 20 }, report: { id: 21 } }), 'review',
    'An unrelated AI report cannot override a current human decision');
  const reviewComments = normalizeInlineReviewComments([
    { id: 10, path: 'src/feature.js', start_line: 12, line: 18, user: { login: 'reviewer' },
      body: REVIEW_MARKER + '\n## Keep both behavior paths\nDetailed reasoning.\n' + optionsBlock,
      html_url: url + '#discussion_r10' },
    { id: 11, path: 'src/old.js', line: null, original_line: 43, body: '  Update the handler' },
    { id: 12, path: 'src/unplaced.js', body: '' },
    { id: 13, body: 'Not an inline comment' }
  ]);
  assert.equal(reviewComments.length, 3, 'Only file-anchored review comments become details');
  assert.equal(reviewComments[0].title, 'Keep both behavior paths');
  assert.equal(reviewComments[0].location, 'L12–L18');
  assert.equal(reviewComments[0].author, 'reviewer');
  assert(!reviewComments[0].text.includes('sweetiebot-merge-options'));
  assert.equal(reviewComments[1].location, 'L43');
  assert.equal(reviewComments[1].outdated, true);
  assert.equal(reviewComments[2].location, 'Line unavailable');
  assert.equal(reviewComments[2].title, 'Code review comment');
  assert.equal(mergePhase({ state: 'open', mergeable: false }, {}), 'conflict');
  assert.equal(mergePhase({ state: 'closed', merged: false, mergeable: false }, {}), 'closed');
  assert.equal(mergePhase({state:'closed',merged:false},{state:'merged',githubMerged:true}),'closed',
    'An explicit closed-without-merge response overrides an earlier success label');
  assert.equal(mergePhase({state:'open',mergeable:true},{state:'merged',githubMerged:false}),'waiting',
    'Legacy local publication is not authoritative native merge evidence');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'unstable' }, {},
    { state: 'pending' }), 'checks-pending', 'Unfinished checks are not failures');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'unstable' }, {},
    { state: 'failed' }), 'checks', 'Actual failed check results get their own status');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'unstable' }, {},
    { state: 'passed' }), 'blocked', 'Stale GitHub mergeability must not invent a check failure');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'unstable' }, {}), 'blocked',
    'Missing check evidence does not assert a failure');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'queued' }, {}), 'queued',
    'GitHub-queued PRs are distinguished from merely awaiting checks');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'unstable',
    head: { sha: nextSha } }, { originalHead: sha, sawConflict: true }, { state: 'failed' }), 'checks',
    'Conflict resolution must not conceal failing checks');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'blocked',
    head: { sha: nextSha } }, { originalHead: sha, sawConflict: true }), 'blocked',
    'A blocked PR is not marked resolved solely because its head changed');
  assert.equal(mergePhase({ state: 'open', mergeable: true,
    head: { sha: nextSha } }, { originalHead: sha, sawConflict: true }), 'resolved');
  assert.equal(mergePhase({ state: 'open', mergeable: true,
    head: { sha } }, { originalHead: sha, sawConflict: true }), 'waiting',
  'A conflict clearing without a verified changed head is not a green resolution');
  assert.equal(mergePhase({ state: 'open', mergeable: true,
    head: { sha } }, { originalHead: sha, review: notes.review }), 'review');
  assert.equal(mergePhase({ state: 'closed', merged_at: '2026-01-01' }, {}), 'merged');
  assert.equal(normalizeFiles([{ filename: 'x.js', additions: 2,
    deletions: 1, patch: '@@ some patch' }])[0].patch, '@@ some patch');

  // Saved activity must survive reload without ever restoring an old merge decision.
  const persisted = new Map();
  const workspaceState = {
    get(key) { return persisted.get(key); },
    async update(key, value) { persisted.set(key, JSON.parse(JSON.stringify(value))); }
  };
  const localContext = { workspaceState };
  const history = createMergeDashboardPersistence(localContext, selection);
  assert.equal(history.selectedNumber(), null);
  history.select(12);
  history.recordEvent({ number: 12, state: 'conflict', message: 'Historical conflict',
    at: '2026-10-24T14:00:00.000Z' });
  history.recordEvent({ number: 99, state: 'merged', message: 'Unselected PR',
    at: '2026-10-24T14:00:00.000Z' });
  history.recordRecovery(12, sha, 'pushed', nextSha);
  await history.flush();
  const saved = createMergeDashboardPersistence(localContext, selection);
  assert.equal(saved.selectedNumber(), 12);
  assert.equal(saved.restoredEvents.length, 1);
  assert.equal(saved.restoredEvents[0].historical, true);
  assert.equal(saved.restoredRecovery[12].lastPushedHead, nextSha);
  assert.equal(saved.restoredRecovery[12].stage, 'pushed');
  assert.equal(saved.restoredEvents[0].message, 'Historical conflict');
  assert.notEqual(stateKey(selection), stateKey({ ...selection, pullRequests: [
    { ...selection.pullRequests[0], headSha: nextSha }] }),
  'Separate selected PR snapshots must not share local history or recovery');
  const poisonedKey = stateKey(selection);
  persisted.set(poisonedKey, { version: 1, selectedNumber: 999,
    events: [{ number: 12, state: 'merged', message: 'old merged', at: 'bad date' },
      { number: 999, state: 'merged', message: 'unrelated', at: '2026-10-24T14:00:00.000Z' }],
    recovery: { 12: { headSha: nextSha, stage: 'merged',
      at: '2026-10-24T14:00:00.000Z' } } });
  const invalid = createMergeDashboardPersistence(localContext, selection);
  assert.equal(invalid.selectedNumber(), null);
  assert.deepEqual(invalid.restoredEvents, []);
  assert.deepEqual(invalid.restoredRecovery, {});
  persisted.delete(poisonedKey);
  console.log('Merge dashboard state, decisions and persistence passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
