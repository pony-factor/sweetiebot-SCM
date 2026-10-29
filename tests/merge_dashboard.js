'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  REPORT_MARKER, REVIEW_MARKER, validateSelection, reportFromComments, normalizeInlineReviewComments,
  mergePhase, normalizeFiles, githubGet, configuredTimelineMode, startMergeDashboard
} = require('../extension/merge/dashboard');
const { formatTimelineTimestamp, formatMergeOutcome } = require('../extension/merge/dashboard_timestamps');
const { renderMergeMarkdown } = require('../extension/merge/dashboard_markdown');
const { mergeActivityPresentation, renderMergeActivitySummary } = require('../extension/merge/dashboard_activity');
const { classifyMergePatchLine, renderMergePatch } = require('../extension/merge/dashboard_diff');
const { parseReportOptions, blockerOptions, manualBlockerActions, dashboardActionPlan, blockerPrompt, reportOptionsInstructions } = require('../extension/merge/blocker_actions');
const { createMergeDashboardPersistence, stateKey } = require('../extension/merge/dashboard_persistence');

(async () => {
  const sha = 'a'.repeat(40);
  const nextSha = 'b'.repeat(40);
  const url = 'https://github.com/pony-factor/example/pull/12';
  const selection = { repository: 'pony-factor/example',
    pullRequests: [{ number: 12, title: 'Fix a conflict', url,
      head: 'feature', base: 'main', headSha: sha }] };
  assert.deepEqual(validateSelection(selection).pullRequests[0].headSha, sha);
  assert.throws(() => validateSelection({ ...selection, repository: '../../evil' }), /Invalid/);
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
    { id: '../unsafe', label: 'Bad', prompt: 'bad' },
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
  const checksPlan = dashboardActionPlan({ state: 'blocked', mergeableState: 'unstable' });
  assert.equal(checksPlan.kind, 'checks');
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
  assert(conflictPrompt.includes('one explanatory commit per actual conflicted file'));
  assert(conflictPrompt.includes('separate sync commit containing only the remaining nonconflicting incoming changes'));
  assert(conflictPrompt.includes('Do not bury conflict decisions'));
  assert(blockerPrompt('pony-factor/example', selection.pullRequests[0], manual[0], 'codex').includes('REPAIR COMMIT HISTORY'));
  const localOption = manual.find(option => option.id === 'resolve-conflicts-local');
  assert.equal(localOption.engine, 'kefania');
  const localPrompt = blockerPrompt('pony-factor/example', selection.pullRequests[0], localOption, 'kefania');
  assert(localPrompt.includes('LOCAL KEFANIA REPAIR'));
  assert(localPrompt.includes('Use operation:"sync" only'));
  assert(!localPrompt.includes('DIRECT WEB REPAIR'));
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
  assert(decisionInstructions.includes('connected user-authenticated GitHub app'),
    'New unresolved decisions also use the connected user identity');
  assert(decisionInstructions.includes('new current-head root inline review comment'),
    'New emoji decisions need independent, current-head inline comments');
  assert(decisionInstructions.includes('publish a new review comment'),
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
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'unstable' }, {}), 'blocked');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'queued' }, {}), 'queued',
    'GitHub-queued PRs are distinguished from merely awaiting checks');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'unstable',
    head: { sha: nextSha } }, { originalHead: sha, sawConflict: true }), 'blocked',
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

  const events = [];
  let messageHandler;
  let disposeHandler;
  let pollCallback;
  let stopped = false;
  const panel = {
    webview: {
      cspSource: 'vscode-webview://test',
      html: '',
      onDidReceiveMessage(fn) { messageHandler = fn; },
      postMessage(msg) { events.push(JSON.parse(JSON.stringify(msg))); return Promise.resolve(true); },
    },
    onDidDispose(fn) { disposeHandler = fn; }
  };
  const openings = [];
  let savedTimelineMode = 'hidden';
  const savedModes = [];
  const layoutConfig = { mergeSidebarWidthPercent: 37, mergeTimelineHeightPercent: 34,
    mergeAutoFixCi: false, mergeAutoFixCiMethod: 'web' };
  let configurationChanged;
  let configurationDisposed = false;
  const configuration = {
    get(key, fallback) { return key === 'mergeTimelineTimestampMode' ? savedTimelineMode : layoutConfig[key] ?? fallback; },
    async update(key, mode, target) {
      if (['mergePostSummaries', 'mergePostStatusUpdates', 'mergeAutoFixCi', 'mergeAutoFixCiMethod'].includes(key)) {
        assert.equal(target, 1); layoutConfig[key] = mode; return;
      }
      assert.equal(key, 'mergeTimelineTimestampMode');
      assert.equal(target, 1, 'Save globally across independent merge windows');
      savedModes.push(mode);
      savedTimelineMode = mode;
    }
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { onDidChangeConfiguration(fn) {
      configurationChanged = fn;
      return { dispose() { configurationDisposed = true; } };
    }, getConfiguration(section) {
      assert.equal(section, 'scmToolkit');
      return configuration;
    } },
    ViewColumn: { Two: 2 },
    window: { createWebviewPanel(id, title, column, options) {
      assert.equal(id, 'sweetiebot.bulkMergeDashboard');
      assert.equal(column, 2);
      assert(options.enableScripts);
      return panel;
    } },
    Uri: { parse: value => value },
    commands: { async executeCommand(command, options) { assert.equal(command, 'workbench.action.browser.open'); assert.equal(options.openToSide, true); openings.push(options.url); } },
    env: { async openExternal() { assert.fail('Dashboard links must never open the external browser'); } }
  };
  let info = {
    number: 12, base: { ref: 'main', sha: 'c'.repeat(40) }, head: { sha, ref: 'feature', repo: { full_name: 'pony-factor/example' } }, html_url: url,
    state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty', body: 'Why this PR exists'
  };
  let commentsForPr = [];
  let inlineCommentsForPr = [];
  let reviewsForPr = [{ id: 70, state: 'COMMENTED', body: 'Existing historical review',
    html_url: url + '#pullrequestreview-70', user: { login: 'reviewer' } }];
  let reactionVotes = [];
  const reactionWrites = [];
  let fileRequests = 0, apiRequests = 0, commitFetches = 0;
  let requestFault, reportFault, pausePRRead;
  const fakeFetch = async (address, options) => {
    if (requestFault) throw requestFault;
    apiRequests++;
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const pathname = new URL(address).pathname;
    if (reportFault && pathname.endsWith('/comments')) throw reportFault;
    if (options.method === 'DELETE' && /\/reactions\/\d+$/.test(pathname)) {
      reactionWrites.push({method:options.method,pathname});
      reactionVotes=reactionVotes.filter(vote=>!pathname.endsWith('/'+vote.id));
      return {ok:true,status:204};
    }
    if (options.method === 'POST' && pathname.endsWith('/reactions')) {
      const vote={id:101,user:{id:41,type:'User'},content:JSON.parse(options.body).content,created_at:'2026-10-23T12:02:00Z'};
      reactionWrites.push({method:options.method,pathname,content:vote.content});reactionVotes.push(vote);
      return {ok:true,json:async()=>vote};
    }
    let result;
    if (pathname === '/user') result = { id: 41, type: 'User' };
    else if (pathname.endsWith('/pulls/comments/90/reactions')) result = reactionVotes;
    else if (pathname.endsWith('/pulls/comments/90')) result = inlineCommentsForPr[0];
    else if (pathname.endsWith('/pulls/12')) result = info;
    else if (pathname.endsWith('/commits')) {
      commitFetches++;
      result = [{ sha, commit: { message: 'Add the feature' }, parents: [] }];
    }
    else if (/\/commits\/[a-f0-9]{40}\/check-runs$/.test(pathname)) result = { check_runs: [
      { id: 1, name: 'CI', status: 'completed', conclusion: 'failure', app: { id: 1 } }] };
    else if (/\/commits\/[a-f0-9]{40}\/check-suites$/.test(pathname)) result = { check_suites: [] };
    else if (/\/commits\/[a-f0-9]{40}\/status$/.test(pathname)) result = { statuses: [] };
    else if (pathname.endsWith('/files')) {
      fileRequests++;
      result = [{ filename: 'src/file.js', status: 'modified',
        additions: 5, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }];
    } else if (pathname.endsWith('/pulls/12/comments')) result = inlineCommentsForPr;
    else if (pathname.endsWith('/pulls/12/reviews')) result = reviewsForPr;
    else if (pathname.endsWith('/issues/12/comments')) result = commentsForPr;
    else throw new Error('Unexpected URL ' + address);
    if (pathname.endsWith('/pulls/12') && pausePRRead) await pausePRRead();
    return { ok: true, json: async () => result };
  };
  const actionLaunches = [];
  const workerFocus = [];
  const refreshedQueues = [];
  panel.visible = false;
  const reactionStorage = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dashboard-reactions-'));
  const dashboard = startMergeDashboard(vscode, selection, 'test-token', {
    onRefresh: async numbers => { refreshedQueues.push(numbers); },
    onFocusWorker: async id => { workerFocus.push(id); },
    context: { globalStorageUri: { fsPath: reactionStorage }, workspaceState },
    launchAction: async (...args) => { actionLaunches.push(args); return true; },
    fetchImpl: fakeFetch,
    intervalMs: 25000,
    setTimer(callback) { pollCallback = callback; return 17; },
    clearTimer(id) { assert.equal(id, 17); stopped = true; }
  });
  assert.equal(apiRequests, 0, 'A dashboard opened in a background tab does not fetch');
  panel.visible = true;
  await dashboard.refresh();
  panel.visible = false; const hiddenRequests = apiRequests; await dashboard.refresh();
  assert.equal(apiRequests, hiddenRequests, 'Hidden dashboards do not poll');
  panel.visible = true;
  assert.equal(dashboard.selection.pullRequests.length, 1);
  assert(panel.webview.html.includes('Lindsey · Bulk merge'));
  assert(panel.webview.html.includes('id="progress"'), 'Keep actionable merge progress visible');
  assert(panel.webview.html.includes('--merge-complete-color:#ac11ff'),
    'Merged PRs use the requested purple');
  assert(panel.webview.html.includes('.flag.merged{color:var(--merge-complete-color);'),
    'Merged PR badges are purple');
  assert(panel.webview.html.includes('.event.merged{border-color:var(--merge-complete-color)}'),
    'Merged timeline events are purple');
  assert(panel.webview.html.includes('.bar-fill{height:100%;background:var(--merge-complete-color);'),
    'The merge completion bar is purple');
  assert(panel.webview.html.includes('.flag.resolved{color:var(--vscode-testing-iconPassed,'),
    'Cleared-conflict badges retain their green state');
  assert(panel.webview.html.includes('.event.resolved{border-color:var(--vscode-testing-iconPassed,'),
    'Cleared-conflict timeline events retain their green state');
  assert(panel.webview.html.includes('id="refresh"'), 'Keep the manual GitHub refresh control');
  assert(panel.webview.html.includes('id="auto-fix-ci"'), 'Lindsey offers an opt-in CI auto-repair toggle');
  assert(panel.webview.html.includes('id="auto-fix-ci-method"'), 'Select an explicit auto-repair runner');
  assert(panel.webview.html.includes('runner-switch'), 'Runner uses the theme-aware sliding pill');
  assert(panel.webview.html.includes("runner.dataset.engine = value"), 'Runner animation follows the selected destination');
  assert(panel.webview.html.includes("workspaceRow.hidden = value !== 'codex'"),
    'Codex branch workspace is visible only with the Codex runner');
  assert(!panel.webview.html.includes("'View instructions'"), 'Implementation prompts are not shown in disclosure balloons');
  assert(!panel.webview.html.includes("show('select', '', undefined, destination)"),
    'Runner no longer uses a dropdown');
  assert(!panel.webview.html.includes('id="count"'), 'Hide the redundant status text next to selected PRs');
  assert(!panel.webview.html.includes('Live GitHub updates · roughly every'), 'Hide the polling cadence from the UI');
  assert(!Object.hasOwn(events.at(-1), 'nextRefreshSeconds'), 'Do not send discarded polling metadata to the webview');
  assert(panel.webview.html.includes('@media(max-width:650px)'),
    'Dashboard stacks its timeline and details in compact merge windows');
  assert(!panel.webview.html.includes('__NONCE__'));
  assert(!panel.webview.html.includes('__MARKDOWN_RENDERER__'));
  assert(panel.webview.html.includes('function renderMergeMarkdown('));
  assert(panel.webview.html.includes('function mergeActivityPresentation('));
  const fetchFailure = mergeActivityPresentation({ number: 252, state: 'error', message: 'Fetch failed',
    details: 'GET /repos/owner/repo/pulls/252/files · Could not resolve api.github.com (ENOTFOUND)' });
  assert.equal(fetchFailure.summary, 'Fetch failed');
  assert.equal(fetchFailure.expandable, true, 'Fetch failures render as expandable disclosure blocks');
  assert(fetchFailure.explanation.includes('ENOTFOUND'));
  const historicalFailure = mergeActivityPresentation({ state: 'error', message: 'fetch failed' });
  assert.equal(historicalFailure.expandable, true);
  assert(historicalFailure.explanation.includes('No request details were captured'));
  assert(!panel.webview.html.includes('__ACTIVITY_RENDERER__'));
  assert(panel.webview.html.includes('renderMergeActivitySummary(content, event.number, presentation, commentOnlyLink)'));
  assert(!panel.webview.html.includes("show('summary', 'muted', 'Details'"));
  assert(panel.webview.html.includes('Saved activity · live GitHub state may have changed'));
  assert(panel.webview.html.includes("dispatch('open-link', undefined, event.url)"));
  const commitActivity = mergeActivityPresentation({ number: 12, commitSha: sha,
    commitTitle: '🔄 Sync branch to main', message: 'Requesting GitHub merge',
    details: 'Codex preserved both APIs.' });
  assert.equal(commitActivity.shortSha, 'aaaaaaa');
  assert.equal(commitActivity.summary, '🔄 Sync branch to main');
  assert.equal(commitActivity.status, 'Requesting GitHub merge');
  assert.equal(commitActivity.explanation, 'Codex preserved both APIs.');
  assert(commitActivity.expandable);
  const noDetails = mergeActivityPresentation({ number: 12, commitSha: sha,
    commitTitle: '🛠️ Refine API', message: '🛠️ Refine API' });
  assert.equal(noDetails.expandable, false);
  const legacy = mergeActivityPresentation({ number: 12,
    message: 'Requesting GitHub merge', details: 'Commit: ' + sha.slice(0, 12) },
    [{ number: 12, commits: [{ sha, commit: { message: '🔄 Sync branch to main' } }] }]);
  assert.equal(legacy.shortSha, 'aaaaaaa');
  assert.equal(legacy.explanation, '');
  assert(legacy.expandable);
  assert(panel.webview.html.includes("show('details', 'review-comment'"),
    'Each code review comment renders in a separate native details disclosure');
  assert(panel.webview.html.includes('expandedReviewComments.has(key)'),
    'Expanded code review comments stay open across dashboard refreshes');
  assert(panel.webview.html.includes('comment.path + \' · \' + comment.location'),
    'The summary includes the original path and line');
  assert(panel.webview.html.includes('function renderMergePatch('));
  assert(!panel.webview.html.includes('__DIFF_RENDERER__'));
  assert(panel.webview.html.includes("renderMergePatch(show('pre', 'diff-patch', undefined, wrap), file.patch)"));
  // VS Code's resolved webview CSS tokens reflect workbench.colorCustomizations from settings.json.
  for (const themeToken of [
    '--vscode-diffEditor-insertedLineBackground',
    '--vscode-diffEditor-removedLineBackground',
    '--vscode-diffEditor-insertedTextBackground',
    '--vscode-diffEditor-removedTextBackground',
    '--vscode-diffEditorGutter-insertedLineBackground',
    '--vscode-diffEditorGutter-removedLineBackground',
  ]) assert(panel.webview.html.includes(themeToken), 'Missing VS Code theme token ' + themeToken);
  assert(panel.webview.html.includes('function formatTimelineTimestamp('));
  assert(panel.webview.html.includes('function formatMergeOutcome('));
  assert(panel.webview.html.includes('formatMergeOutcome(pr.mergedAt, pr.mergeCommit, model.timestampMode)'),
    'Verified merge outcome uses the selected time preference');
  assert(panel.webview.html.includes("outcome.textContent = formatMergeOutcome(pr.mergedAt, pr.mergeCommit, 'relative')"),
    'Relative verified merge times continue updating');
  assert(!panel.webview.html.includes('__TIMESTAMP_FORMATTER__'));
  assert(panel.webview.html.includes('id="timeline-time-mode"'));
  assert(panel.webview.html.includes("dispatch('select-pr', pr.number)"));
  assert(panel.webview.html.includes('Saved activity · live GitHub state may have changed'));
  assert(panel.webview.html.includes('setInterval(refreshRelativeEventTimes, 30000)'));
  assert.equal(configuredTimelineMode(vscode), 'hidden');
  assert.equal(events.at(-1).timestampMode, 'hidden', 'Timestamps start hidden');
  assert.equal(events.at(-1).showPrCommits, true, 'Commit history remains visible by default');
  assert(panel.webview.html.includes("model.showPrCommits !== false"), "PR commit tree is conditional");
  assert(panel.webview.html.includes(".pr-detail-layout.no-commits{display:block}"), "Hidden tree restores full-width diff");
  layoutConfig.mergeShowPrCommits = false;
  configurationChanged({ affectsConfiguration: key => key === 'scmToolkit.mergeShowPrCommits' });
  assert.equal(events.at(-1).showPrCommits, false, 'Setting hides commit history in an open dashboard');
  layoutConfig.mergeShowPrCommits = true;
  configurationChanged({ affectsConfiguration: key => key === 'scmToolkit.mergeShowPrCommits' });
  assert.equal(events.at(-1).showPrCommits, true, 'Setting restores commit history without reopening');

  assert.deepEqual(events.at(-1).layoutPreferences, { sidebar: 37, timeline: 34 });
  layoutConfig.mergeSidebarWidthPercent = 50;
  layoutConfig.mergeTimelineHeightPercent = 55;
  configurationChanged({ affectsConfiguration: key => key === 'scmToolkit.mergeSidebarWidthPercent' });
  assert.deepEqual(events.at(-1).layoutPreferences, { sidebar: 50, timeline: 55 }, 'Settings update open dashboards immediately');
  layoutConfig.mergeSidebarWidthPercent = 99;
  configurationChanged({ affectsConfiguration: () => true });
  assert.equal(events.at(-1).layoutPreferences.sidebar, 37, 'Reject invalid configured proportions');
  assert.equal(typeof pollCallback, 'function');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(events.at(-1).prs[0].state, 'conflict');
  assert(events.at(-1).events.some(event => event.message.includes('merge conflicts')));
  assert(!events.at(-1).events.some(event => event.state === 'review-comment'),
    'Existing reviews must not be reported as newly posted');
  assert(panel.webview.html.includes('dispatch(\'open-link\', undefined, event.url)'),
    'Timeline review entries open their GitHub source in the browser');
  await dashboard.flushLocalState();
  assert(createMergeDashboardPersistence(localContext, selection).restoredEvents.some(event =>
    event.message.includes('merge conflicts')), 'Timeline history persists without persisting merge state');
  assert.equal(events.at(-1).prs[0].state, 'conflict', 'Live GitHub alone determines merge eligibility');
  await messageHandler({ type: 'timestamp-mode', mode: 'relative' });
  assert.deepEqual(savedModes, ['relative']);
  assert.equal(events.at(-1).timestampMode, 'relative', 'Relative mode is reflected immediately');
  await messageHandler({ type: 'timestamp-mode', mode: 'clock' });
  assert.equal(events.at(-1).timestampMode, 'clock');
  await messageHandler({ type: 'timestamp-mode', mode: 'hidden' });
  assert.equal(events.at(-1).timestampMode, 'hidden');
  await messageHandler({ type: 'timestamp-mode', mode: 'unexpected' });
  assert.deepEqual(savedModes, ['relative', 'clock', 'hidden'],
    'Reject unrecognized timestamp modes without changing persisted settings');

  info = { ...info, head: { ...info.head, sha: nextSha }, mergeable: true, mergeable_state: 'clean' };
  commentsForPr = [{ id: 16, body: REPORT_MARKER + '\nMechanically reconciled both changes.' }];
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].state, 'resolved');
  assert.deepEqual(refreshedQueues.at(-1), [12], 'Verified cleared conflicts notify the active merge coordinator');
  assert(events.at(-1).prs[0].report.text.includes('Mechanically'));
  assert(fileRequests >= 2, 'Head changes refresh the file diff');
  messageHandler({ type: 'open-pr', number: 12 });
  messageHandler({ type: 'open-diff', number: 12 });
  messageHandler({ type: 'open-pr', number: 100 });
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(openings, [url, url + '/files']);
  await messageHandler({ type: 'open-link', url: url + '#issuecomment-123' });
  await messageHandler({ type: 'open-link', url: 'https://example.org/reference' });
  await messageHandler({ type: 'open-link', url: 'javascript:alert(1)' });
  await messageHandler({ type: 'open-link', url: 'https://github.com@evil.example/path' });
  await messageHandler({ type: 'open-link', url: 'file:///private/secret' });
  await messageHandler({ type: 'open-link', url: 'https://example.org/' + 'x'.repeat(5000) });
  assert.deepEqual(openings, [url, url + '/files', url + '#issuecomment-123', 'https://example.org/reference'],
    'Validated comment links open once in the integrated browser with their comment fragment preserved');
  commentsForPr = [{ id: 16, body: REPORT_MARKER + '\nChoose API compatibility.\n' + optionsBlock }];
  info = { ...info, mergeable_state: 'unstable' };
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].state, 'blocked');
  assert.equal(events.at(-1).events.at(-1).message, 'PR is open; checks are not passing');
  const selectedAction = events.at(-1).prs[0].blockerOptions[0];
  const actionMessage = { type: 'blocker-action', number: 12, headSha: nextSha,
    actionId: selectedAction.id, optionKey: selectedAction.key };
  await messageHandler(actionMessage);
  assert.equal(actionLaunches.length, 1);
  assert.equal(actionLaunches[0][6], 'web', 'GPT web is the default destination');
  assert.equal(actionLaunches[0][5].id, 'report-preserve-api');
  await messageHandler({ ...actionMessage, engine: 'codex' });
  assert.equal(actionLaunches[1][6], 'codex');
  await messageHandler({ ...actionMessage, optionKey: 'forged' });
  assert.equal(actionLaunches.length, 2, 'Unknown or modified options never launch');
  info = { ...info, head: { ...info.head, sha } };
  await messageHandler(actionMessage);
  assert.equal(actionLaunches.length, 2, 'A stale selected head never launches');
  info = { ...info, head: { ...info.head, sha: nextSha } };
  info = { ...info, mergeable_state: 'blocked' };
  await dashboard.refresh();
  assert.equal(events.at(-1).events.at(-1).message, 'PR is open; merging is blocked',
    'A changed blocking reason is reported even when the phase stays blocked');
  inlineCommentsForPr = [{ id: 90, path: 'src/file.js', line: 1, side: 'RIGHT',
    html_url: url + '#discussion_r90',
    body: REVIEW_MARKER + '\nWhich API should this conflict preserve?\n' + liveDecisions },
    { id: 91, path: 'src/another.js', original_line: 21,
      body: 'Consider the old caller, too.' }];
  info = { ...info, head: { ...info.head, sha }, mergeable_state: 'clean', mergeable: true };
  await dashboard.refresh();
  const inlinePr = events.at(-1).prs[0];
  assert.equal(inlinePr.review.text, 'Which API should this conflict preserve?');
  assert.equal(inlinePr.review.url, url + '#discussion_r90');
  assert.equal(inlinePr.inlineReviewComments.length, 2);
  assert.equal(inlinePr.inlineReviewComments[0].location, 'L1');
  assert.equal(inlinePr.inlineReviewComments[1].location, 'L21');
  assert.equal(inlinePr.inlineReviewComments[1].title, 'Consider the old caller, too.');
  const inlineChoice = inlinePr.blockerOptions.find(option => option.id === 'report-90-keep-api');
  assert(inlineChoice, 'Inline code-thread choices are available in the dashboard');
  const inlineAction = { type: 'blocker-action', number: 12, headSha: sha,
    actionId: inlineChoice.id, optionKey: inlineChoice.key };
  await messageHandler(inlineAction);
  assert.equal(actionLaunches.length, 3, 'Inline options survive the fresh action lookup');
  assert.equal(actionLaunches[2][4].review.url, url + '#discussion_r90');
  inlineCommentsForPr = [];
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].review, null, 'Removed live review clears on the next poll');
  assert.notEqual(events.at(-1).prs[0].state, 'review');
  await messageHandler(inlineAction);
  assert.equal(actionLaunches.length, 3, 'Removed inline choices cannot execute from a stale dashboard');
  const reactionBlock = '<!-- sweetiebot-merge-options\n' + JSON.stringify({
    version: 1, headSha: nextSha, baseSha: 'c'.repeat(40), options: [
      { id: 'adapter', label: 'Keep both APIs', prompt: 'Add an adapter.', reaction: '+1' },
      { id: 'new-api', label: 'Adopt new API', prompt: 'Update callers.', reaction: 'heart' }
    ] }) + '\n-->';
  inlineCommentsForPr = [{ id: 90, path: 'src/file.js', line: 1, side: 'RIGHT',
    commit_id: nextSha, updated_at: '2026-10-23T12:00:00Z', html_url: url + '#discussion_r90',
    body: REVIEW_MARKER + '\nChoose the API.\n' + reactionBlock }];
  reactionVotes = [{ id: 100, user: { id: 41, type: 'User' }, content: 'heart', created_at: '2026-10-23T12:01:00Z' }];
  info = { ...info, head: { ...info.head, sha: nextSha }, base: { ...info.base, sha: 'c'.repeat(40) } };
  await dashboard.refresh();
  assert.equal(actionLaunches.length, 4, 'Dashboard polling dispatches the user reaction');
  assert.equal(actionLaunches[3][5].id, 'report-new-api');
  assert.equal(actionLaunches[3][6], 'web');
  assert.equal(actionLaunches[3][4].review.url, url + '#discussion_r90');
  await dashboard.refresh();
  assert.equal(actionLaunches.length, 4, 'Polling cannot repeat the reaction task');
  const buttonChoice=events.at(-1).prs[0].blockerOptions.find(option=>option.reaction==='+1');
  await messageHandler({type:'blocker-action',number:12,headSha:nextSha,actionId:buttonChoice.id,optionKey:buttonChoice.key});
  assert.deepEqual(reactionWrites.map(write=>write.method),['DELETE','POST'],'A button changes only the signed-in user’s reaction');
  assert.equal(reactionWrites[1].content,'+1');
  assert.equal(actionLaunches.length,5,'The recorded reaction drives the implementation route');
  await dashboard.refresh();
  assert.equal(actionLaunches.length,5,'Button and polling cannot dispatch the same reaction twice');

  // A new review body, inline comment, and Conversation comment have distinct
  // timeline entries. Pending reviews, previously seen comments, and special
  // merge-report markers do not create duplicate review-comment events.
  const reviewEvents = () => events.at(-1).events.filter(event => event.state === 'review-comment');
  const previousReviewEvents = reviewEvents().length;
  reviewsForPr = [...reviewsForPr,
    { id: 71, state: 'COMMENTED', body: 'Reviewed the changed behavior.',
      html_url: url + '#pullrequestreview-71', user: { login: 'reviewer' } },
    { id: 72, state: 'PENDING', body: 'Not submitted yet',
      html_url: url + '#pullrequestreview-72', user: { login: 'reviewer' } }];
  inlineCommentsForPr.push({ id: 92, path: 'src/file.js', line: 22,
    html_url: url + '#discussion_r92', user: { login: 'reviewer' },
    body: 'This branch still needs a fallback.' });
  commentsForPr.push({ id: 18, html_url: url + '#issuecomment-18',
    user: { login: 'reviewer' }, body: 'Posted an additional review note.' });
  for (let attempt = 0; attempt < 3; attempt++) await dashboard.refresh();
  assert.equal(reviewEvents().length, previousReviewEvents + 3, 'Each new comment type adds exactly one activity entry without deleting earlier activity');
  assert(reviewEvents().some(event => event.message === 'PR review submitted' &&
    event.url === url + '#pullrequestreview-71'));
  assert(reviewEvents().some(event => event.message === 'Inline review comment posted' &&
    event.details.includes('src/file.js:22') && event.url === url + '#discussion_r92'));
  assert(reviewEvents().some(event => event.message === 'PR conversation comment posted' &&
    event.details.includes('@reviewer')));
  assert(!reviewEvents().some(event => event.details.includes('Not submitted yet')));
  for (let attempt = 0; attempt < 3; attempt++) await dashboard.refresh();
  assert.equal(reviewEvents().length, previousReviewEvents + 3, 'Repeated GitHub polling never duplicates comment entries');
  reviewsForPr[2].state = 'COMMENTED';
  for (let attempt = 0; attempt < 3; attempt++) await dashboard.refresh();
  assert.equal(reviewEvents().length, previousReviewEvents + 4, 'A pending review creates an event only after submission');

  const stateBeforeProgress = events.at(-1).prs[0].state;
  dashboard.recordLocalProgress({ number: 12, stage: 'preparing', description: 'Preserve the existing API and add optional tax.' });
  assert.equal(events.at(-1).prs[0].localExplanation, 'Preserve the existing API and add optional tax.');
  assert.equal(events.at(-1).postSummaries, false);
  await messageHandler({ type: 'post-summaries', enabled: true });
  assert.equal(events.at(-1).postSummaries, true);
  await messageHandler({ type: 'post-summaries', enabled: false });
  assert.equal(events.at(-1).postSummaries, false);
  assert.equal(events.at(-1).postStatusUpdates, false);
  await messageHandler({ type: 'post-status-updates', enabled: true });
  assert.equal(events.at(-1).postStatusUpdates, true);
  assert.equal(events.at(-1).postSummaries, false, 'Status updates have an independent preference');
  await messageHandler({ type: 'post-status-updates', enabled: 'false' });
  assert.equal(events.at(-1).postStatusUpdates, true, 'Invalid messages cannot change the preference');
  await messageHandler({ type: 'post-status-updates', enabled: false });
  assert.equal(events.at(-1).postStatusUpdates, false);
  dashboard.recordLocalProgress({ number: 12, stage: 'prepared', sha });
  assert.equal(events.at(-1).prs[0].activity.phase, 'prepared');
  assert.match(events.at(-1).prs[0].activity.message, /squash prepared locally/);
  dashboard.recordLocalProgress({ number: 12, stage: 'decision-commit', sha,
    path: 'src/file.js', title: '🛠️ Keep both APIs', description: 'Preserve existing callers with an adapter.' });
  assert.equal(events.at(-1).events.at(-1).commitSha, sha);
  assert.equal(events.at(-1).events.at(-1).commitTitle, '🛠️ Keep both APIs');
  assert(events.at(-1).events.at(-1).details.includes('Keep both APIs'));
  assert(events.at(-1).events.at(-1).details.includes('src/file.js'));
  assert.equal(events.at(-1).prs[0].localDecisions['src/file.js'].description, 'Preserve existing callers with an adapter.');
  dashboard.recordLocalProgress({ number: 12, stage: 'pushed', sha, title: '🔄 Sync branch to main' });
  assert.equal(events.at(-1).events.at(-1).commitTitle, '🔄 Sync branch to main');
  assert.match(mergeActivityPresentation(events.at(-1).events.at(-1)).summary, /pushed to the PR branch/,
    'Operational timeline entries lead with the runner action rather than hiding it behind a commit title');
  assert(!events.at(-1).events.at(-1).details);
  await dashboard.flushLocalState();
  assert.equal(createMergeDashboardPersistence(localContext, selection).restoredRecovery[12].stage, 'pushed');

  assert.match(events.at(-1).events.at(-1).message, /not merged/);
  dashboard.recordLocalResult({ repository: selection.repository, results: [{ number: 12,
    status: 'blocked', preparedHead: sha, reason: 'PR changed after guarded push' }] });
  assert.match(events.at(-1).events.at(-1).message, /Stopped after pushing/);
  assert.match(events.at(-1).events.at(-1).details, /PR changed after guarded push/);
  assert.equal(events.at(-1).events.at(-1).commitSha, sha);
  assert.equal(events.at(-1).prs[0].state, stateBeforeProgress, 'Local push activity does not claim GitHub merged');
  const eventCount = events.at(-1).events.length;
  dashboard.recordLocalProgress({ number: 99, stage: 'preparing' });
  dashboard.recordLocalProgress({ number: 12, stage: 'invented' });
  assert.equal(events.at(-1).events.length, eventCount);
  const batchState = { repository: selection.repository,
    deferred: [{ number: 12, reason: 'Refresh the selected head before another merge attempt.' }] };
  batchState.history = [{ number: 12, explanation: 'Restored local explanation', decisions: [{ path: 'src/file.js', title: '🛠️ Keep both APIs', description: 'Restored decision' }] }];
  dashboard.recordBatchState(batchState);
  dashboard.recordBatchState({ ...batchState, workers: [{ id: 1, label: 'Oldest first', phase: 'Reviewing',
    numbers: [12, 999], merged: 0, total: 1 }] });
  assert.deepEqual(events.at(-1).workers[0].numbers, [12]);
  await messageHandler({ type: 'focus-worker', number: 1 });
  await messageHandler({ type: 'focus-worker', number: 999 });
  assert.deepEqual(workerFocus, [1], 'Only registered GPT review sessions can be focused');
  assert.equal(events.at(-1).prs[0].localExplanation, 'Restored local explanation');
  assert.equal(events.at(-1).prs[0].localDecisions['src/file.js'].description, 'Restored decision');
  assert.match(events.at(-1).events.at(-1).message, /Deferred for this batch/);
  assert.match(events.at(-1).events.at(-1).details, /Refresh the selected head/);
  dashboard.recordBatchState(batchState);
  assert.equal(events.at(-1).events.length, eventCount + 1, 'Repeating batch state does not duplicate deferral events');
  const runningState = { repository: selection.repository, deferred: [], activities: { 12: {
    phase: 'reviewing', message: 'Review round 2 · waiting for GPT handoff', round: 2, at: '2026-10-27T15:00:00Z'
  } } };
  dashboard.recordBatchState(runningState);
  const runningCount = events.at(-1).events.length;
  assert.equal(events.at(-1).prs[0].activity.phase, 'reviewing');
  assert.match(events.at(-1).events.at(-1).message, /waiting for GPT/);
  dashboard.recordBatchState(runningState);
  assert.equal(events.at(-1).events.length, runningCount, 'Repeated snapshots do not flood the activity log');
  dashboard.recordBatchState(runningState, { restored: true });
  assert.equal(events.at(-1).prs[0].activity.phase, 'paused');
  assert.match(events.at(-1).prs[0].activity.message, /Runner not resumed/);
  // Retargeting a stacked PR must not freeze the live status, diff or commits.
  // Keep the execution selection unchanged; never authorize a different base.
  info = { ...info, title: selection.pullRequests[0].title, base: { ...info.base, ref: 'new-base' },
    mergeable: true, mergeable_state: 'clean' };
  const commitsBeforeRetarget = commitFetches;
  await dashboard.refresh({ force: true });
  let retargeted = events.at(-1).prs[0];
  assert.notEqual(retargeted.state, 'blocked');
  assert.equal(retargeted.mergeableState, 'clean');
  assert.equal(retargeted.currentBase, 'new-base');
  assert.equal(retargeted.base, 'main', 'Read-only polling preserves the authorized execution base');
  assert.equal(retargeted.actionPlan.kind, 'snapshot');
  assert.deepEqual(retargeted.blockerOptions, [], 'Retargeted selections cannot dispatch stale choices');
  assert.deepEqual(retargeted.manualActions.map(action => action.id), ['resolve-conflicts-local']);
  assert(commitFetches > commitsBeforeRetarget, 'A base-only change refreshes commit history');
  const directRepair = retargeted.manualActions[0];
  const directMessage = { type: 'blocker-action', number: 12, headSha: retargeted.currentHead,
    baseRef: 'new-base', actionId: directRepair.id, optionKey: directRepair.key, engine: directRepair.engine };
  const launchesBeforeRepair = actionLaunches.length;
  await messageHandler(directMessage);
  assert.equal(actionLaunches.length, launchesBeforeRepair + 1, 'Retargeted PRs retain a working direct repair button');
  assert.equal(actionLaunches.at(-1)[6], 'kefania');
  assert.equal(actionLaunches.at(-1)[4].base, 'new-base', 'Repair uses the displayed and reverified base');
  assert.equal(actionLaunches.at(-1)[4].snapshotChanged, false, 'A new repair has its own verified selection');
  info = { ...info, base: { ...info.base, ref: 'moved-again' } };
  await messageHandler(directMessage);
  assert.equal(actionLaunches.length, launchesBeforeRepair + 1, 'A base changed since display cannot start a repair');
  info = { ...info, base: { ...info.base, ref: 'new-base' } };
  dashboard.recordBatchState({ repository: selection.repository, deferred: [{ number: 12,
    reason: 'The selected PR changed outside this batch; review the new head or PR state.' }] });
  assert.equal(events.at(-1).prs[0].snapshotDeferred, true, 'Old persisted snapshot deferrals have the same recovery guidance');
  info = { ...info, base: { ...info.base, ref: 'main' } };
  await dashboard.refresh({ force: true });
  assert.equal(events.at(-1).prs[0].actionPlan.kind, 'snapshot', 'Returning to the original base does not resume a deferred batch');
  assert.equal(events.at(-1).autoFixCi, false);
  await messageHandler({ type: 'auto-fix-ci-method', method: 'invalid' });
  assert.equal(layoutConfig.mergeAutoFixCiMethod, 'web');
  await messageHandler({ type: 'auto-fix-ci-method', method: 'codex' });
  await messageHandler({ type: 'auto-fix-ci', enabled: true });
  assert.equal(events.at(-1).autoFixCiMethod, 'codex');
  assert.equal(events.at(-1).autoFixCi, true);
  info = { ...info, state: 'open', merged: false, head: { ...info.head, sha: nextSha },
    mergeable_state: 'unstable', base: { ...info.base, sha: 'c'.repeat(40) } };
  inlineCommentsForPr = [];
  commentsForPr = [];
  await dashboard.refresh();
  const repairState = { repository: selection.repository,
    pullRequests: [{ ...selection.pullRequests[0], headSha: nextSha, baseSha: 'c'.repeat(40) }],
    history: [{ number: 12, status: 'checks_failed', sourceHeadSha: sha }],
    deferred: [{ number: 12, reason: 'Integrated checks failed twice.' }] };
  const autoStart = actionLaunches.length;
  dashboard.recordBatchState(repairState);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(actionLaunches.length, autoStart + 1, 'Launch once when selected integrated-head CI fails');
  assert.equal(actionLaunches.at(-1)[6], 'codex', 'Auto repair uses the configured method');
  dashboard.recordBatchState(repairState);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(actionLaunches.length, autoStart + 1, 'Polling cannot duplicate an auto-repair');
  await messageHandler({ type: 'auto-fix-ci', enabled: false });
  assert.equal(events.at(-1).autoFixCi, false);
  requestFault = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  await dashboard.refresh({ force: true });
  const failedFetch = events.at(-1).events.at(-1);
  assert.equal(failedFetch.message, 'Fetch failed');
  assert(failedFetch.details.includes('GET /repos/pony-factor/example/pulls/12'));
  assert(failedFetch.details.includes('ENOTFOUND'));
  assert.equal(mergeActivityPresentation(failedFetch).expandable, true);
  requestFault = undefined;
  info = { ...info, state: 'closed', merged: false };
  await Promise.all([dashboard.refresh(), dashboard.refresh()]);
  assert.equal(events.at(-1).prs[0].state, 'closed');
  assert.equal(events.at(-1).events.at(-1).message, 'PR was closed without merging');
  // A verified executor result updates the badge immediately, even in a hidden
  // dashboard with an older open response already in flight and a failed poll.
  info = { ...info, state: 'open', merged: false };
  panel.visible = false;
  let releaseRead, readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  pausePRRead = async () => { readStarted(); await readGate; };
  const stalePoll = dashboard.refresh({ force: true });
  await started;
  pausePRRead = undefined;
  dashboard.recordLocalResult({ repository: selection.repository,
    results: [{ number: 12, status: 'merged', merged: true, sha: 'c'.repeat(40) }] });
  assert.equal(events.at(-1).prs[0].state, 'merged', 'Verified merge results update the badge before polling');
  assert.equal(events.at(-1).prs[0].statusMessage, 'GitHub confirms the pull request was merged');
  assert.equal(events.at(-1).prs[0].mergeCommit, 'c'.repeat(40));
  assert(!events.at(-1).prs[0].mergedAt, 'A result without a GitHub timestamp must not invent one');
  requestFault = new TypeError('fetch failed');
  releaseRead();
  await stalePoll;
  await dashboard.refresh({ force: true });
  assert.equal(events.at(-1).prs[0].state, 'merged', 'An in-flight open response and failed follow-up cannot regress the badge');
  requestFault = undefined;
  await dashboard.refresh({ force: true });
  assert.equal(events.at(-1).prs[0].state, 'merged', 'A stale GitHub open response cannot undo a verified merge');
  panel.visible = true;
  reportFault = new TypeError('comments unavailable');
  info = { ...info, state: 'closed', merged: true, merged_at: '2026-10-20T12:00:00Z',
    merge_commit_sha: 'c'.repeat(40) };
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].state, 'merged');
  assert.equal(events.at(-1).prs[0].mergedAt, info.merged_at, 'Core merge metadata updates even when comment fetching fails');
  assert.match(events.at(-1).error, /issues\/12\/comments/);
  reportFault = undefined;
  await dashboard.refresh({ force: true });
  assert.equal(events.at(-1).prs[0].conflictCleared, true, 'Verified cleared conflicts remain counted after merge');
  assert(events.at(-1).events.some(event => event.state === 'merged'));
  const mergedRequestCount=apiRequests;
  await dashboard.refresh();
  assert.equal(apiRequests,mergedRequestCount,'Verified merged PRs do not consume requests on every timer tick');
  await dashboard.refresh({force:true});
  assert(apiRequests>mergedRequestCount,'Explicit refresh can still update merged PR comments');
  disposeHandler();
  assert(stopped);
  assert(configurationDisposed);
  const countBefore = events.length;
  await dashboard.refresh();
  assert.equal(events.length, countBefore);
  fs.rmSync(reactionStorage, { recursive: true, force: true });

  await assert.rejects(githubGet(async () => ({ ok: false, status: 403 }), 'test-token',
    'pony-factor/example', '/pulls/12'), /HTTP 403/);
  const requestFailure = cause => githubGet(async () => { throw new TypeError('fetch failed', { cause }); },
    'test-token', 'pony-factor/example', '/pulls/12/files');
  await assert.rejects(requestFailure({ code: 'ENOTFOUND' }), error => {
    assert(error.message.includes('GET /repos/pony-factor/example/pulls/12/files'));
    assert(error.message.includes('Could not resolve api.github.com'));
    assert(!error.message.includes('test-token'));
    return true;
  });
  await assert.rejects(requestFailure({ errors: [{ code: 'ECONNREFUSED' }] }), /connection was refused/);
  await assert.rejects(requestFailure({ code: 'UND_ERR_CONNECT_TIMEOUT' }), /Connecting to GitHub timed out/);
  await assert.rejects(requestFailure(undefined), /No HTTP response was received/);
  await assert.rejects(githubGet(async () => ({ ok: false, status: 401 }), 'test-token',
    'pony-factor/example', '/pulls/12'), /HTTP 401.*Sign in again/);
  await assert.rejects(githubGet(async () => ({ ok: false, status: 429,
    json: async () => ({ message: 'API rate limit exceeded' }) }), 'test-token',
  'pony-factor/example', '/pulls/12'), error => error.rateLimited === true && error.retryAt > Date.now());
  await assert.rejects(githubGet(async () => ({ ok: true,
    json: async () => { throw new SyntaxError('Unexpected token'); } }), 'test-token',
  'pony-factor/example', '/pulls/12'), /response could not be read as JSON/);
  assert(fs.readFileSync(require('node:path').join(__dirname, '../extension/merge/dashboard.html'),
    'utf8').includes('Changed files'));
  // A mock DOM tests Markdown semantics without trusting any source HTML.
  const document = { createElement(tag) {
    return { tag, ownerDocument: document, children: [], handlers: {},
      appendChild(child) { this.children.push(child); },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      set textContent(value) { this.text = String(value); },
      get textContent() { return this.text ?? this.children.map(child => child.textContent).join(''); }
    };
  } };
  const summaryRoot = document.createElement('div');
  renderMergeActivitySummary(summaryRoot, 12, commitActivity);
  assert.deepEqual(summaryRoot.children.map(child => child.tag), ['span', 'code', 'span']);
  assert.equal(summaryRoot.children[1].className, 'event-commit-sha');
  assert.equal(summaryRoot.children[1].textContent, 'aaaaaaa');
  const commentActivity = mergeActivityPresentation({ number: 513,
    state: 'review-comment', message: 'PR conversation comment posted' });
  const commentRoot = document.createElement('div');
  const commentLink = renderMergeActivitySummary(commentRoot, 513, commentActivity, true);
  assert.deepEqual(commentRoot.children.map(node => node.tag), ['span', 'span'],
    'Conversation entry keeps its PR number outside any hyperlink');
  assert.equal(commentRoot.children[0].textContent, '#513 ');
  assert.deepEqual(commentRoot.children[1].children.map(node => node.tag), ['span', 'a', 'span'],
    'Only the conversation comment phrase becomes an anchor');
  assert.equal(commentRoot.children[1].children[0].textContent, 'PR ');
  assert.equal(commentLink.textContent, 'conversation comment');
  assert.equal(commentRoot.children[1].children[2].textContent, ' posted');
  const plainCommentRoot = document.createElement('div');
  assert.equal(renderMergeActivitySummary(plainCommentRoot, 513, commentActivity), null,
    'A timeline event without a GitHub URL remains plain text');
  assert.equal(plainCommentRoot.children[1].textContent, 'PR conversation comment posted');
  assert(panel.webview.html.includes("const target = commentLink || content;"),
    'Only the dedicated comment anchor receives the external navigation handler');
  const root = document.createElement('div');
  const clicked = [];
  const tick = String.fromCharCode(96);
  renderMergeMarkdown(root, [
    '## **PR summary**',
    '- [x] **Fixed** [related PR](https://github.com/pony-factor/example/pull/5)',
    '- Bare https://example.org/path.',
    '| Name | Status |', '| --- | --- |', '| Demo | complete |',
    '> _Quoted_ text',
    tick + tick + tick + 'html', '<script>alert(1)</script>', tick + tick + tick,
    '[Unsafe](javascript:alert(1)) and ![remote](https://example.org/tracker.png)'
  ].join('\n'), { openLink: href => clicked.push(href) });
  const walk = n => [n, ...n.children.flatMap(walk)];
  const elements = walk(root);
  const tags = elements.map(n => n.tag);
  for (const tag of ['h2', 'strong', 'ul', 'li', 'input', 'a', 'table', 'blockquote', 'pre', 'code']) {
    assert(tags.includes(tag), 'Markdown element ' + tag + ' renders');
  }
  assert(!tags.includes('script') && !tags.includes('img'),
    'Raw HTML and remote images never become executable or fetched elements');
  assert(root.textContent.includes('<script>alert(1)</script>'),
    'Code remains literal text');
  const anchors = elements.filter(n => n.tag === 'a');
  assert(anchors.some(n => n.href === 'https://example.org/path'),
    'Bare URL becomes clickable without trailing punctuation');
  assert(!anchors.some(n => n.href.startsWith('javascript:')),
    'Unsafe link schemes remain plain text');
  const related = anchors.find(n => n.href.endsWith('/pull/5'));
  let linkPrevented = false, linkStopped = false;
  related.handlers.click({ preventDefault() { linkPrevented = true; }, stopPropagation() { linkStopped = true; } });
  assert(linkPrevented && linkStopped, 'Handled dashboard links suppress default navigation and bubbling');
  assert.deepEqual(clicked, ['https://github.com/pony-factor/example/pull/5']);
  // A linked GitHub image in the original PR description should render like
  // GitHub, without trusting raw HTML or requesting arbitrary remote images.
  const imageRoot = document.createElement('div');
  const attachment = 'https://github.com/user-attachments/assets/2d5481b8-54dc-48c6-87e5-b67927d630bd';
  const imageClicks = [];
  renderMergeMarkdown(imageRoot, [
    '<p align="center"><a href="https://github.com/pony-factor/kefania"><img src="' +
      attachment + '" alt="Write PR descriptions automatically."></a></p>',
    '![Screenshot](https://user-images.githubusercontent.com/60260750/123/screenshot.png)',
    '![Tracker](https://example.org/tracker.png)',
    '<img src="' + attachment + '" alt="Safe image" onerror="alert(1)">',
    '<img src="javascript:alert(1)" alt="Unsafe image">',
    '<img src="https://github.com.evil.invalid/user-attachments/assets/fake" alt="Fake attachment">',
    '<img src="http://github.com/user-attachments/assets/fake" alt="Insecure attachment">',
    '<script>alert(1)</script>'
  ].join(String.fromCharCode(10)), { openLink: href => imageClicks.push(href) });
  const imageElements = walk(imageRoot);
  const images = imageElements.filter(item => item.tag === 'img');
  assert.equal(images.length, 3, 'Only allow trusted HTTPS GitHub-hosted images');
  assert.deepEqual(images.map(item => item.alt),
    ['Write PR descriptions automatically.', 'Screenshot', 'Safe image']);
  assert(images.every(item => item.loading === 'lazy' && item.referrerPolicy === 'no-referrer'));
  assert(images.every(item => item.onerror === undefined && item.handlers.error === undefined),
    'Untrusted event handlers must not be copied onto image elements');
  assert(imageElements.some(item => item.className === 'markdown-image-center'),
    'Center the HTML image banner');
  const bannerLink = imageElements.find(item => item.tag === 'a' && item.href === 'https://github.com/pony-factor/kefania');
  assert(bannerLink.children.some(item => item.tag === 'img'), 'Keep the banner image inside its link');
  bannerLink.handlers.click({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(imageClicks, ['https://github.com/pony-factor/kefania']);
  assert(imageElements.some(item => item.tag === 'a' && item.textContent === 'Image: Tracker'),
    'Off-site Markdown images remain plain links');
  assert(!imageElements.some(item => item.tag === 'script'), 'Raw HTML must never be executed');
  assert(imageRoot.textContent.includes('javascript:alert(1)'),
    'Invalid image schemes remain visible as text');

  const emphasisRoot = document.createElement('div');
  renderMergeMarkdown(emphasisRoot, '**bold *italic* ending** and *italic **bold** ending* plus ***both***.');
  assert.equal(emphasisRoot.textContent, 'bold italic ending and italic bold ending plus both.');
  const emphasisNodes = walk(emphasisRoot);
  assert(emphasisNodes.some(n => n.tag === 'strong' && n.children.some(c => c.tag === 'em')));
  assert(emphasisNodes.some(n => n.tag === 'em' && n.children.some(c => c.tag === 'strong')));
  const previewLinkRoot = document.createElement('div');
  renderMergeMarkdown(previewLinkRoot, '[Gallery] (https://derpicdn.net/some.png)',
    { mapLink: () => 'https://derpibooru.org/images/42' });
  const previewLink = walk(previewLinkRoot).find(n => n.tag === 'a');
  assert.equal(previewLink.href, 'https://derpibooru.org/images/42');
  assert.equal(previewLink.target, '_blank');
  const now = new Date(2026, 9, 21, 6, 15, 0).getTime();
  assert.equal(formatTimelineTimestamp(new Date(now - 120000).toISOString(), 'hidden', now), '');
  assert.equal(formatTimelineTimestamp(new Date(now - 120000).toISOString(), 'relative', now), '2m ago');
  assert.equal(formatTimelineTimestamp(new Date(now - 7200000).toISOString(), 'relative', now), '2h ago');
  assert.equal(formatTimelineTimestamp(new Date(now - 86400000).toISOString(), 'relative', now), '1d ago');
  assert.equal(formatTimelineTimestamp(new Date(now + 120000).toISOString(), 'relative', now), 'in 2m');
  assert.equal(formatTimelineTimestamp(new Date(now).toISOString(), 'relative', now), 'just now');
  assert.equal(formatTimelineTimestamp('not-a-date', 'relative', now), '');
  assert.equal(formatTimelineTimestamp(new Date(now - 120000).toISOString(), 'clock', now),
    new Date(now - 120000).toLocaleTimeString(), 'Clock mode respects the local timezone');
  assert.equal(formatTimelineTimestamp(new Date(now - 172800000).toISOString(), 'clock', now),
    new Date(now - 172800000).toLocaleString(), 'Older clock timestamps include their date');
  const mergedAt = new Date(now - 120000).toISOString();
  const mergeCommit = 'c'.repeat(40);
  assert.equal(formatMergeOutcome(mergedAt, mergeCommit, 'hidden', now),
    'GitHub merged this PR\nSquash/merge commit: ' + mergeCommit,
    'Hidden mode suppresses the verified merge time without hiding the commit');
  assert.equal(formatMergeOutcome(mergedAt, mergeCommit, 'relative', now),
    'GitHub merged this PR 2m ago\nSquash/merge commit: ' + mergeCommit);
  assert.equal(formatMergeOutcome(mergedAt, mergeCommit, 'clock', now),
    'GitHub merged this PR at ' + new Date(mergedAt).toLocaleTimeString() +
      '\nSquash/merge commit: ' + mergeCommit);
  assert.equal(formatMergeOutcome(mergedAt, '', 'hidden', now),
    'GitHub merged this PR', 'Outcome remains readable when no merge commit is present');
  // GitHub patches must be line-colored, not rendered as one plain preformatted string.
  const patch = [
    '@@ -10,3 +10,4 @@',
    ' unchanged context',
    '-old statement',
    '+new statement',
    '+++ b/filename.js',
    '--- a/filename.js',
    '\\ No newline at end of file',
    '+<img src=x onerror=alert(1)>',
    ''
  ].join('\n');
  const renderedDiff = document.createElement('pre');
  renderMergePatch(renderedDiff, patch);
  assert.deepEqual(renderedDiff.children.map(item => item.className), [
    'diff-line diff-line--hunk',
    'diff-line diff-line--context',
    'diff-line diff-line--removed',
    'diff-line diff-line--added',
    'diff-line diff-line--meta',
    'diff-line diff-line--meta',
    'diff-line diff-line--note',
    'diff-line diff-line--added'
  ]);
  assert.equal(renderedDiff.children[2].children[0].textContent, '-');
  assert.equal(renderedDiff.children[2].children[1].textContent, 'old statement');
  assert.equal(renderedDiff.children[3].children[0].textContent, '+');
  assert.equal(renderedDiff.children[3].children[1].textContent, 'new statement');
  assert.equal(renderedDiff.children[7].children[1].textContent, '<img src=x onerror=alert(1)>',
    'GitHub patch HTML remains inert literal text');
  assert.equal(renderedDiff.children.length, 8, 'Final newline adds no phantom diff row');
  assert.equal(classifyMergePatchLine('diff --git a/file b/file'), 'meta');
  assert.equal(classifyMergePatchLine('-removed'), 'removed');
  assert.equal(classifyMergePatchLine('+added'), 'added');
  assert.equal(classifyMergePatchLine('@@ -1 +1 @@'), 'hunk');
  assert.equal(classifyMergePatchLine(' context'), 'context');
  assert.equal(classifyMergePatchLine('+++ b/file'), 'meta');
  console.log('Live merge dashboard, Markdown, themed diffs, links, timestamps and status checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
