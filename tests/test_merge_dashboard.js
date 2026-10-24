'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  REPORT_MARKER, REVIEW_MARKER, validateSelection, reportFromComments,
  mergePhase, normalizeFiles, githubGet, configuredTimelineMode, startMergeDashboard
} = require('../efs/merge_dashboard');
const { formatTimelineTimestamp, formatMergeOutcome } = require('../efs/merge_dashboard_timestamps');
const { renderMergeMarkdown } = require('../efs/merge_dashboard_markdown');
const { classifyMergePatchLine, renderMergePatch } = require('../efs/merge_dashboard_diff');
const { parseReportOptions, blockerOptions, manualBlockerActions, blockerPrompt, reportOptionsInstructions } = require('../efs/merge_blocker_actions');

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
  assert.equal(manual.length, 5);
  assert(manual.every(action => action.manual && !action.reaction));
  assert.equal(manual.find(action => action.id === 'inspect-codex').engine, 'codex');
  assert.deepEqual(manualBlockerActions({state:'merged'}), []);
  const selectedPrompt = blockerPrompt('pony-factor/example', selection.pullRequests[0], choices[0]);
  assert(selectedPrompt.includes('Preserve the current API and add the proposed compatibility layer.'));
  assert(selectedPrompt.includes('does not authorize merging or closing'));
  assert(selectedPrompt.includes('connected GitHub app authenticated as the user'),
    'ChatGPT implementation responses must use the connected user account');
  assert(selectedPrompt.includes('reply_to_review_comment'),
    'Implementation results must create a new reply to the original inline review');
  assert(selectedPrompt.includes('If an inline reply cannot be posted'),
    'Non-inline fallback must still reference the original review');
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
  assert.equal(mergePhase({ state: 'open', mergeable: false }, {}), 'conflict');
  assert.equal(mergePhase({ state: 'closed', merged: false, mergeable: false }, {}), 'closed');
  assert.equal(mergePhase({ state: 'open', mergeable: true, mergeable_state: 'unstable' }, {}), 'blocked');
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
  const layoutConfig = { mergeSidebarWidthPercent: 37, mergeTimelineHeightPercent: 34 };
  let configurationChanged;
  let configurationDisposed = false;
  const configuration = {
    get(key, fallback) { return key === 'mergeTimelineTimestampMode' ? savedTimelineMode : layoutConfig[key] ?? fallback; },
    async update(key, mode, target) {
      if (key === 'mergePostSummaries') { layoutConfig.mergePostSummaries = mode; return; }
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
    env: { async openExternal(target) { openings.push(target); } }
  };
  let info = {
    number: 12, base: { ref: 'main' }, head: { sha, ref: 'feature', repo: { full_name: 'pony-factor/example' } }, html_url: url,
    state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty', body: 'Why this PR exists'
  };
  let commentsForPr = [];
  let inlineCommentsForPr = [];
  let reactionVotes = [];
  const reactionWrites = [];
  let fileRequests = 0, apiRequests = 0;
  const fakeFetch = async (address, options) => {
    apiRequests++;
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const pathname = new URL(address).pathname;
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
    else if (pathname.endsWith('/commits')) result = [{ sha, commit: { message: 'Add the feature' }, parents: [] }];
    else if (pathname.endsWith('/files')) {
      fileRequests++;
      result = [{ filename: 'src/file.js', status: 'modified',
        additions: 5, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }];
    } else if (pathname.endsWith('/pulls/12/comments')) result = inlineCommentsForPr;
    else if (pathname.endsWith('/issues/12/comments')) result = commentsForPr;
    else throw new Error('Unexpected URL ' + address);
    return { ok: true, json: async () => result };
  };
  const actionLaunches = [];
  panel.visible = false;
  const reactionStorage = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dashboard-reactions-'));
  const dashboard = startMergeDashboard(vscode, selection, 'test-token', {
    context: { globalStorageUri: { fsPath: reactionStorage } },
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
  assert(panel.webview.html.includes('id="refresh"'), 'Keep the manual GitHub refresh control');
  assert(!panel.webview.html.includes('id="count"'), 'Hide the redundant status text next to selected PRs');
  assert(!panel.webview.html.includes('Live GitHub updates · roughly every'), 'Hide the polling cadence from the UI');
  assert(!Object.hasOwn(events.at(-1), 'nextRefreshSeconds'), 'Do not send discarded polling metadata to the webview');
  assert(panel.webview.html.includes('@media(max-width:650px)'),
    'Dashboard stacks its timeline and details in compact merge windows');
  assert(!panel.webview.html.includes('__NONCE__'));
  assert(!panel.webview.html.includes('__MARKDOWN_RENDERER__'));
  assert(panel.webview.html.includes('function renderMergeMarkdown('));
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
  assert(panel.webview.html.includes('setInterval(refreshRelativeEventTimes, 30000)'));
  assert.equal(configuredTimelineMode(vscode), 'hidden');
  assert.equal(events.at(-1).timestampMode, 'hidden', 'Timestamps start hidden');
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
  assert(events.at(-1).prs[0].report.text.includes('Mechanically'));
  assert(fileRequests >= 2, 'Head changes refresh the file diff');
  messageHandler({ type: 'open-pr', number: 12 });
  messageHandler({ type: 'open-diff', number: 12 });
  messageHandler({ type: 'open-pr', number: 100 });
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(openings, [url, url + '/files']);
  await messageHandler({ type: 'open-link', url: 'https://example.org/reference' });
  await messageHandler({ type: 'open-link', url: 'javascript:alert(1)' });
  await messageHandler({ type: 'open-link', url: 'https://github.com@evil.example/path' });
  await messageHandler({ type: 'open-link', url: 'file:///private/secret' });
  await messageHandler({ type: 'open-link', url: 'https://example.org/' + 'x'.repeat(5000) });
  assert.deepEqual(openings, [url, url + '/files', 'https://example.org/reference'],
    'Only validated web links open through the extension host');
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
    body: REVIEW_MARKER + '\nWhich API should this conflict preserve?\n' + optionsBlock }];
  info = { ...info, head: { ...info.head, sha }, mergeable_state: 'clean', mergeable: true };
  await dashboard.refresh();
  const inlinePr = events.at(-1).prs[0];
  assert.equal(inlinePr.review.text, 'Which API should this conflict preserve?');
  assert.equal(inlinePr.review.url, url + '#discussion_r90');
  const inlineChoice = inlinePr.blockerOptions.find(option => option.id === 'report-90-preserve-api');
  assert(inlineChoice, 'Inline code-thread choices are available in the dashboard');
  const inlineAction = { type: 'blocker-action', number: 12, headSha: sha,
    actionId: inlineChoice.id, optionKey: inlineChoice.key };
  await messageHandler(inlineAction);
  assert.equal(actionLaunches.length, 3, 'Inline options survive the fresh action lookup');
  assert.equal(actionLaunches[2][4].review.url, url + '#discussion_r90');
  inlineCommentsForPr = [];
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

  const stateBeforeProgress = events.at(-1).prs[0].state;
  dashboard.recordLocalProgress({ number: 12, stage: 'preparing', description: 'Preserve the existing API and add optional tax.' });
  assert.equal(events.at(-1).prs[0].localExplanation, 'Preserve the existing API and add optional tax.');
  assert.equal(events.at(-1).postSummaries, false);
  await messageHandler({ type: 'post-summaries', enabled: true });
  assert.equal(events.at(-1).postSummaries, true);
  await messageHandler({ type: 'post-summaries', enabled: false });
  assert.equal(events.at(-1).postSummaries, false);
  dashboard.recordLocalProgress({ number: 12, stage: 'prepared', sha });
  dashboard.recordLocalProgress({ number: 12, stage: 'decision-commit', sha,
    path: 'src/file.js', title: '🛠️ Keep both APIs', description: 'Preserve existing callers with an adapter.' });
  assert(events.at(-1).events.at(-1).details.includes('Keep both APIs'));
  assert(events.at(-1).events.at(-1).details.includes('src/file.js'));
  assert.equal(events.at(-1).prs[0].localDecisions['src/file.js'].description, 'Preserve existing callers with an adapter.');
  dashboard.recordLocalProgress({ number: 12, stage: 'pushed', sha });
  assert.match(events.at(-1).events.at(-1).message, /not merged/);
  dashboard.recordLocalResult({ repository: selection.repository, results: [{ number: 12,
    status: 'blocked', preparedHead: sha, reason: 'PR changed after guarded push' }] });
  assert.match(events.at(-1).events.at(-1).message, /Stopped after pushing/);
  assert.match(events.at(-1).events.at(-1).details, /PR changed after guarded push/);
  assert.equal(events.at(-1).prs[0].state, stateBeforeProgress, 'Local push activity does not claim GitHub merged');
  const eventCount = events.at(-1).events.length;
  dashboard.recordLocalProgress({ number: 99, stage: 'preparing' });
  dashboard.recordLocalProgress({ number: 12, stage: 'invented' });
  assert.equal(events.at(-1).events.length, eventCount);
  const batchState = { repository: selection.repository,
    deferred: [{ number: 12, reason: 'Refresh the selected head before another merge attempt.' }] };
  batchState.history = [{ number: 12, explanation: 'Restored local explanation', decisions: [{ path: 'src/file.js', title: '🛠️ Keep both APIs', description: 'Restored decision' }] }];
  dashboard.recordBatchState(batchState);
  assert.equal(events.at(-1).prs[0].localExplanation, 'Restored local explanation');
  assert.equal(events.at(-1).prs[0].localDecisions['src/file.js'].description, 'Restored decision');
  assert.match(events.at(-1).events.at(-1).message, /Deferred for this batch/);
  assert.match(events.at(-1).events.at(-1).details, /Refresh the selected head/);
  dashboard.recordBatchState(batchState);
  assert.equal(events.at(-1).events.length, eventCount + 1, 'Repeating batch state does not duplicate deferral events');
  info = { ...info, state: 'closed', merged: false };
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].state, 'closed');
  assert.equal(events.at(-1).events.at(-1).message, 'PR was closed without merging');
  info = { ...info, state: 'closed', merged: true, merged_at: '2026-10-20T12:00:00Z',
    merge_commit_sha: 'c'.repeat(40) };
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].state, 'merged');
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
  assert(fs.readFileSync(require('node:path').join(__dirname, '../efs/merge_dashboard.html'),
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
  related.handlers.click({ preventDefault() {} });
  assert.deepEqual(clicked, ['https://github.com/pony-factor/example/pull/5']);
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
