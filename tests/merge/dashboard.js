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
  const sha = 'a'.repeat(40);
  const nextSha = 'b'.repeat(40);
  const url = 'https://github.com/pony-factor/example/pull/12';
  const selection = { repository: 'pony-factor/example',
    pullRequests: [{ number: 12, title: 'Fix a conflict', url,
      head: 'feature', base: 'main', headSha: sha }] };
  const optionsBlock = '<!-- sweetiebot-merge-options\n' + JSON.stringify({ version: 1, options: [
    { id: 'preserve-api', label: 'Keep the current API', description: 'Add compatibility for the PR.', prompt: 'Preserve the current API and add the proposed compatibility layer.', engine: 'shell' },
    { id: 'replace-api', label: 'Adopt the new API', prompt: 'Update callers to the new interface.' },
    { id: '../../unsafe', label: 'Bad', prompt: 'bad' },
    { id: 'invalid', label: 'Empty prompt', prompt: '' }
  ] }) + '\n-->';
  const liveDecisions = '<!-- sweetiebot-merge-options\n' + JSON.stringify({
    version: 1, headSha: sha, baseSha: 'c'.repeat(40), options: [
      { id: 'keep-api', label: 'Keep API', prompt: 'Keep the original API.' },
      { id: 'adapt-api', label: 'Use adapter', prompt: 'Introduce an adapter.' }
    ]
  }) + '\n-->';
  const persisted = new Map();
  const workspaceState = {
    get(key) { return persisted.get(key); },
    async update(key, value) { persisted.set(key, JSON.parse(JSON.stringify(value))); }
  };
  const localContext = { workspaceState };

  const events = [];
  let messageHandler;
  let disposeHandler;
  let pollCallback;
  let stopped = false;
  const panel = {
    webview: {
      cspSource: 'vscode-webview://test',
      html: '',
      asWebviewUri(uri) {
        assert(fs.existsSync(uri.fsPath), 'Dashboard artwork must exist in the runtime layout');
        return 'vscode-webview://test/' + require('node:path').basename(uri.fsPath);
      },
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
      if (['mergePostSummaries', 'mergePostStatusUpdates', 'mergeAutoFixCi', 'mergeAutoFixConflicts', 'mergeAutoFixCiMethod', 'mergeShowPrCommits'].includes(key)) {
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
      assert.equal(section, 'sweetiebot');
      return configuration;
    } },
    ViewColumn: { Two: 2 },
    window: { createWebviewPanel(id, title, column, options) {
      assert.equal(id, 'sweetiebot.bulkMergeDashboard');
      assert.equal(column, 2);
      assert(options.enableScripts);
      return panel;
    } },
    Uri: { parse: value => value, file: fsPath => ({ fsPath }) },
    commands: { async executeCommand(command, options) { assert.equal(command, 'workbench.action.browser.open'); assert.equal(options.openToSide, true); openings.push(options.url); } },
    env: { async openExternal(url) { openings.push(url); return true; } }
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
  let checkConclusion = 'failure';
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
    else if (pathname.includes('/branches/')) result = {commit:{sha:'c'.repeat(40)}};
    else if (pathname.endsWith('/commits')) {
      commitFetches++;
      result = [{ sha, commit: { message: 'Add the feature' }, parents: [] }];
    }
    else if (/\/commits\/[a-f0-9]{40}\/check-runs$/.test(pathname)) result = { check_runs: [
      { id: 1, name: 'CI', status: checkConclusion === null ? 'in_progress' : 'completed',
        conclusion: checkConclusion, app: { id: 1 } }] };
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
  // Local handoffs use the signed-in user's token even when separate Apps are enabled.
  const previousIdentityMode = process.env.SWEETIEBOT_BOT_IDENTITY_MODE;
  process.env.SWEETIEBOT_BOT_IDENTITY_MODE = 'separate-apps';
  let launchResult = true;
  const dashboard = startMergeDashboard(vscode, selection, 'test-token', {
    onRefresh: async numbers => { refreshedQueues.push(numbers); },
    onFocusWorker: async id => { workerFocus.push(id); },
    context: { globalStorageUri: { fsPath: reactionStorage }, workspaceState },
    launchAction: async (...args) => { actionLaunches.push(args); return launchResult; },
    fetchImpl: fakeFetch,
    intervalMs: 25000,
    setTimer(callback) { pollCallback = callback; return 17; },
    clearTimer(id) { assert.equal(id, 17); stopped = true; }
  });
  assert.equal(apiRequests, 0, 'A dashboard opened in a background tab does not fetch');
  panel.visible = true;
  await dashboard.refresh();
  if (previousIdentityMode === undefined) delete process.env.SWEETIEBOT_BOT_IDENTITY_MODE;
  else process.env.SWEETIEBOT_BOT_IDENTITY_MODE = previousIdentityMode;
  const firstCheckAt = events.at(-1).prs[0].lastGitHubCheckAt;
  assert(Number.isFinite(Date.parse(firstCheckAt)), 'Successful GitHub refreshes update Current activity metadata');
  const initialEvents = events.at(-1).events.length;
  await dashboard.refresh();
  assert.equal(events.at(-1).events.length, initialEvents,
    'An unchanged GitHub refresh records no start/completion history entries');
  assert(Number.isFinite(Date.parse(events.at(-1).prs[0].lastGitHubCheckAt)),
    'Routine polling still refreshes the current GitHub check time');
  panel.visible = false; const hiddenRequests = apiRequests; await dashboard.refresh();
  assert.equal(apiRequests, hiddenRequests, 'Hidden dashboards do not poll');
  panel.visible = true;
  assert.equal(dashboard.selection.pullRequests.length, 1);
  assert(panel.webview.html.includes('<h1>Lindsey</h1>'), 'Keep the Lindsey identity visible in the header');
  assert(panel.webview.html.includes("const target = commentLink || content;"),
    'Only the dedicated comment anchor receives the external navigation handler');
  assert(!panel.webview.html.includes('<h1>Lindsey · Bulk merge</h1>'), 'Do not restore the bulk merge subtitle');
  assert(!panel.webview.html.includes('id="repository"'), 'Omit the repository logo from the stripped-down header');
  assert(panel.webview.html.includes('<h2 id="completion-title">Win</h2>'), 'Show the concise completion heading');
  assert(panel.webview.html.includes('id="completion" class="completion"'), 'Dedicated finish page');
  assert(panel.webview.html.includes('id="review-merges"'), 'Keep PR details and timeline available');
  assert(panel.webview.html.includes('id="show-celebration"'), 'Allow return to finish page');
  assert(panel.webview.html.includes("url('vscode-webview://test/bulk-merge-cannon.jpeg')"),
     'The supplied full-size artwork is loaded through the approved bundled-asset URI');
   assert(panel.webview.html.includes('background-size:cover'), 'Artwork fills the complete confirmation window');
   assert(panel.webview.html.includes('body.celebrating{'), 'The background is limited to verified bulk-merge completion');
   assert(!panel.webview.html.includes('<img class="completion-art"'), 'Artwork is not confined to a small inline image');
   assert(panel.webview.html.includes('href="https://x.com/fcolumnare/status/1952740544443998252"'),
     'Artist attribution is linked directly on the confirmation screen');
  assert(panel.webview.html.includes('>Cerberus</a>'), 'Credit the artist by name');
  assert(!panel.webview.html.includes('@fcolumnare'), 'Omit the artist handle from visible credits');
  assert(!panel.webview.html.includes('__MERGE_CELEBRATION_PREDICATE__'));
  assert(!panel.webview.html.includes('__CELEBRATION_BACKGROUND__'));
  assert(panel.webview.html.includes('if (!complete) celebrationDismissed = false'));
  assert(panel.webview.html.includes('complete && !celebrationDismissed'));
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
  assert(panel.webview.html.includes('.flag.checks{color:var(--vscode-charts-blue,'),
    'Checks-not-passing PR badges use blue instead of blocked red');
  assert(panel.webview.html.includes('.event.checks{border-color:var(--vscode-charts-blue,'),
    'Checks-not-passing timeline entries use blue');
  assert(panel.webview.html.includes("checks: 'Checks failing'"),
    'Failed CI has an explicit qualifier');
  assert(panel.webview.html.includes("'checks-pending': 'Running checks'"),
    'Unfinished CI is labeled Running checks rather than a failure');
  assert(panel.webview.html.includes('.flag.checks-pending{color:var(--vscode-progressBar-background,'),
    'In-progress CI has its own progress-colored badge');
  assert(panel.webview.html.includes('.event.checks-pending{border-color:var(--vscode-progressBar-background,'),
    'In-progress CI has its own timeline styling');
  assert(panel.webview.html.includes('id="refresh"'), 'Keep the manual GitHub refresh control');
  assert(panel.webview.html.includes('id="auto-fix-ci"'), 'Lindsey keeps a CI auto-repair toggle');
  assert(panel.webview.html.includes('On by default; turn off to disable automatic repair.'),
    'CI repair is the default without overriding an explicitly disabled preference');
  const extensionSettings = JSON.parse(fs.readFileSync(require.resolve('../../extension/package.json'), 'utf8'));
  assert.equal(extensionSettings.contributes.configuration.properties['sweetiebot.mergeAutoFixCi'].default, true,
    'Automatic CI repair is enabled for installations without a saved preference');
  assert(panel.webview.html.includes('id="auto-fix-ci-method"'), 'Select an explicit auto-repair runner');
  assert(panel.webview.html.includes('id="auto-fix-menu"'),
    'Automatic fixing uses the same dropdown as GitHub posting');
  assert(panel.webview.html.includes('role="group" aria-label="Automatic fixing options"'));
  assert(panel.webview.html.includes('id="auto-fix-conflicts"> Conflicts</label>'));
  assert.equal(extensionSettings.contributes.configuration.properties['sweetiebot.mergeAutoFixConflicts'].default, false);
  assert(panel.webview.html.includes('for="auto-fix-ci-method">using</label>'),
    'Keep the inline method label lowercase');
  assert(!panel.webview.html.includes('for="auto-fix-ci-method">Using</label>'),
    'Avoid regressing to capitalized Using');
  assert(panel.webview.html.includes('id="github-post-menu"'),
    'Group the two GitHub posting preferences in one compact disclosure');
  assert(panel.webview.html.includes('<summary class="github-post-trigger">Post to GitHub'),
    'Label the posting menu without adding a master on/off switch');
  assert(panel.webview.html.includes('role="group" aria-label="GitHub posting options"'),
    'Expose the individual posting preferences accessibly');
  assert(panel.webview.html.includes('id="post-summaries"> AI summaries</label>'),
    'AI summaries retain their independent checkbox');
  assert(panel.webview.html.includes('id="post-status-updates"> Status updates</label>'),
    'Status updates retain their independent checkbox');
  assert(panel.webview.html.includes('function updateGitHubPostingCount()') &&
    panel.webview.html.includes("enabled === 0 ? 'Off' : enabled + ' enabled'"),
    'The collapsed menu reflects how many posting options are enabled');
  assert(panel.webview.html.includes("type: 'post-summaries', enabled: event.target.checked") &&
    panel.webview.html.includes("type: 'post-status-updates', enabled: event.target.checked"),
    'Both existing GitHub posting messages are preserved');
  assert(panel.webview.html.includes("event.key === 'Escape' && menu.open") &&
    panel.webview.html.includes("!menu.contains(event.target)"),
    'Escape and outside clicks dismiss the menu');
  assert(panel.webview.html.includes('class="merge-header"'), 'Bulk dashboard uses the shared header');
  assert(panel.webview.html.includes('.merge-header .dashboard-brand'), 'Shared header CSS is inlined');
  assert(!panel.webview.html.includes('__MERGE_HEADER_CSS__'), 'No unexpanded header placeholder');
  assert(panel.webview.html.includes('class="dashboard-brand"'),
    'Keep the Lindsey name and review indicators grouped in the header');
  assert(panel.webview.html.includes('id="merge-workers"'), 'Retain the oldest/newest review lanes');
  assert(panel.webview.html.includes('id="conflicts-cleared"'), 'Retain the standalone cleared-conflicts counter');
  assert(panel.webview.html.includes('aria-label="Bulk merge preferences"'),
    'Group merge preferences accessibly');
  assert(panel.webview.html.includes('class="toolbar-option"'),
    'Show custom but theme-aware checkbox labels in the merge toolbar');
  assert(panel.webview.html.includes('id="progress" class="pill" role="status" aria-live="polite"'),
    'Announce merge progress changes without removing the compact status pill');
  assert(panel.webview.html.includes('.overview input[type="checkbox"]:focus-visible'),
    'Retain keyboard focus styling for custom checkbox controls');
  assert(panel.webview.html.includes('.pr[aria-current="true"]::before'),
    'Visually distinguish the selected PR without relying only on background color');
  assert(panel.webview.html.includes('@media(max-width:1250px)'),
    'Wrap toolbar options instead of clipping them at medium widths');
  assert(panel.webview.html.includes('@media(prefers-reduced-motion:reduce)'),
    'Honor reduced-motion preferences for dashboard transitions');
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
  assert(panel.webview.html.includes('class="activity-github-check"') ||
    panel.webview.html.includes("'activity-github-check'"),
    'Successful background checks are shown inline in Current activity');
  assert(panel.webview.html.includes("GitHub checked "),
    'Current activity exposes the last successful GitHub polling time');
  assert(panel.webview.html.includes("dispatch('select-pr', pr.number)"));
  assert(panel.webview.html.includes('Saved activity · live GitHub state may have changed'));
  assert(panel.webview.html.includes('setInterval(refreshRelativeEventTimes, 30000)'));
  assert.equal(configuredTimelineMode(vscode), 'hidden');
  assert.equal(events.at(-1).timestampMode, 'hidden', 'Timestamps start hidden');
  assert.equal(events.at(-1).showPrCommits, true, 'Commit history remains visible by default');
  assert(panel.webview.html.includes("model.showPrCommits !== false"), "PR commit tree is conditional");
  assert(panel.webview.html.includes(".pr-detail-layout.no-commits{display:block}"), "Hidden tree restores full-width diff");
  assert(panel.webview.html.includes("const commitToggle = show('button', 'secondary commit-tree-toggle'"),
    'A permanent hamburger control is available even when the commit tree is hidden');
  assert(panel.webview.html.includes("commitToggle.setAttribute('aria-expanded', String(showCommits))"),
    'The hamburger exposes its expanded state to assistive technology');
  assert(panel.webview.html.includes("commitToggle.setAttribute('aria-controls', 'pr-commit-tree')"),
    'The hamburger explicitly controls the commit graph');
  assert(panel.webview.html.includes("tree.hidden = !showCommits"),
    'Collapsed graphs do not obstruct the PR diff');
  assert(panel.webview.html.includes("model.showPrCommits = !showCommits"),
    'The hamburger changes local visibility before the global preference is saved');
  assert(panel.webview.html.includes("vscode.postMessage({ type: 'show-pr-commits', enabled: model.showPrCommits })"),
    'The hamburger broadcasts its preference for all PRs');
  assert(panel.webview.html.includes("byId('details').querySelector('.commit-tree-toggle')?.focus()"),
    'Keyboard focus returns to the toggle after the PR details re-render');
  layoutConfig.mergeShowPrCommits = false;
  configurationChanged({ affectsConfiguration: key => key === 'sweetiebot.mergeShowPrCommits' });
  assert.equal(events.at(-1).showPrCommits, false, 'Setting hides commit history in an open dashboard');
  layoutConfig.mergeShowPrCommits = true;
  configurationChanged({ affectsConfiguration: key => key === 'sweetiebot.mergeShowPrCommits' });
  assert.equal(events.at(-1).showPrCommits, true, 'Setting restores commit history without reopening');
  await messageHandler({ type: 'show-pr-commits', enabled: false });
  assert.equal(layoutConfig.mergeShowPrCommits, false, 'Hamburger choice is saved to global configuration');
  assert.equal(events.at(-1).showPrCommits, false, 'All PRs receive the collapsed state');
  await messageHandler({ type: 'show-pr-commits', enabled: 'false' });
  assert.equal(layoutConfig.mergeShowPrCommits, false, 'Malformed toggle messages cannot change the setting');
  await messageHandler({ type: 'show-pr-commits', enabled: true });
  assert.equal(layoutConfig.mergeShowPrCommits, true, 'The same global preference reopens every commit graph');
  assert.equal(events.at(-1).showPrCommits, true, 'Reopened history is published without switching PRs');

  assert.deepEqual(events.at(-1).layoutPreferences, { sidebar: 37, timeline: 34 });
  layoutConfig.mergeSidebarWidthPercent = 50;
  layoutConfig.mergeTimelineHeightPercent = 55;
  configurationChanged({ affectsConfiguration: key => key === 'sweetiebot.mergeSidebarWidthPercent' });
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

  // A normal external fix must notify the coordinator even before GitHub
  // reports that a previously conflicted PR is mergeable again.
  info = { ...info, head: { ...info.head, sha: nextSha } };
  await dashboard.refresh();
  assert.deepEqual(refreshedQueues.at(-1), [12],
    'A newly pushed head reaches the active batch without a conflict-cleared prerequisite');
  info = { ...info, head: { ...info.head, sha } };
  await dashboard.refresh();
  // Keep the three-cycle review-comment polling phase aligned with the
  // original regression sequence after simulating two additional head polls.
  await dashboard.refresh();

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
    'Validated comment links open once in the default browser with their comment fragment preserved');
  await messageHandler({type:'open-commit',number:12,url:sha});
  assert.equal(openings.at(-1),'https://github.com/pony-factor/example/commit/'+sha,
    'Commit links use the default browser too');
  const beforeInvalidCommit=openings.length;
  await messageHandler({type:'open-commit',number:12,url:'f'.repeat(40)});
  assert.equal(openings.length,beforeInvalidCommit,'Only known PR commits may be opened');
  commentsForPr = [{ id: 16, body: REPORT_MARKER + '\nChoose API compatibility.\n' + optionsBlock }];
  info = { ...info, mergeable_state: 'unstable' };
  checkConclusion = null;
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].state, 'checks-pending');
  assert.equal(events.at(-1).events.at(-1).state, 'checks-pending');
  assert.equal(events.at(-1).events.at(-1).message, 'PR is open; checks are queued or in progress');
  checkConclusion = 'failure';
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].state, 'checks');
  assert.equal(events.at(-1).events.at(-1).state, 'checks');
  assert.equal(events.at(-1).events.at(-1).message, 'PR is open; one or more checks failed');
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
  assert.equal(events.at(-1).prs[0].state, 'blocked');
  assert.equal(events.at(-1).events.at(-1).message, 'PR is open; merging is blocked',
    'Branch restrictions remain distinct from checks that are not passing');
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
  dashboard.recordLocalProgress({ number: 12, stage: 'additional-files', additionalFiles: ['tests/supporting.test.mjs', '../outside'] });
  assert.deepEqual(events.at(-1).prs[0].additionalFiles, ['tests/supporting.test.mjs']);
  await dashboard.refresh();
  assert.deepEqual(events.at(-1).prs[0].additionalFiles, ['tests/supporting.test.mjs'], 'GitHub refresh preserves extra-file highlights');
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
  const pushedEvent = events.at(-1).events.findLast(event => event.commitTitle === '🔄 Sync branch to main');
  assert.equal(pushedEvent.location, 'upstream');
  assert.match(mergeActivityPresentation(pushedEvent).summary, /pushed to the PR branch/,
    'Operational timeline entries lead with the runner action rather than hiding it behind a commit title');
  assert(!pushedEvent.details);
  await dashboard.flushLocalState();
  assert.equal(createMergeDashboardPersistence(localContext, selection).restoredRecovery[12].stage, 'pushed');

  assert.match(pushedEvent.message, /not merged/);
  dashboard.recordLocalResult({ repository: selection.repository, results: [{ number: 12,
    status: 'blocked', preparedHead: sha, reason: 'PR changed after guarded push' }] });
  const blockedEvent = events.at(-1).events.findLast(event => event.state === 'blocked');
  assert.match(blockedEvent.message, /Stopped after pushing/);
  assert.match(blockedEvent.details, /PR changed after guarded push/);
  assert.equal(blockedEvent.commitSha, sha);
  assert.equal(events.at(-1).prs[0].state, stateBeforeProgress, 'Local push activity does not claim GitHub merged');
  const beforeRoutineStages = events.at(-1).events.length;
  dashboard.recordLocalProgress({number:12,stage:'integrating'});
  assert.equal(events.at(-1).prs[0].activity.location, 'local');
  assert.equal(events.at(-1).events.length, beforeRoutineStages,
    'Routine local integration updates Current activity without creating history');
  const poll={number:12,stage:'checks-polled',sha,state:'pending',nextPollAt:Date.now()+15000,
    evidence:[{name:'Regression tests',result:'in_progress'}]};
  dashboard.recordLocalProgress(poll);
  assert.equal(events.at(-1).prs[0].activity.location,'upstream');
  assert.equal(events.at(-1).prs[0].activity.phase,'waiting-checks');
  assert.deepEqual(events.at(-1).prs[0].activity.checks,
    [{name:'Regression tests',result:'in_progress'}],
    'Routine check evidence remains visible in Current activity');
  assert.equal(events.at(-1).events.length, beforeRoutineStages,
    'Pending GitHub check polls do not create historical entries');
  const pollCount=events.at(-1).events.length,stepStarted=events.at(-1).prs[0].activity.at;
  dashboard.recordLocalProgress({...poll,nextPollAt:Date.now()+16000});
  assert.equal(events.at(-1).events.length,pollCount,'Unchanged check polls refresh the live status without flooding history');
  assert.equal(events.at(-1).prs[0].activity.at,stepStarted,'A poll cannot restart the elapsed step clock');
  assert(Number.isFinite(Date.parse(events.at(-1).prs[0].activity.updatedAt)),
    'A real GitHub polling event refreshes the last-update timestamp');
  dashboard.recordLocalProgress({...poll, state:'failed', evidence:[{name:'Regression tests', result:'failure'}]});
  assert.equal(events.at(-1).events.at(-1).message, 'GitHub checks: failed · 1 checks reported',
    'A failing check remains a meaningful timeline event');
  assert.equal(events.at(-1).prs[0].activity.phase, 'checks_failed');
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
  assert.match(events.at(-1).prs[0].activity.message, /waiting for GPT/,
    'GPT review waits remain visible in Current activity, not history');
  assert.equal(events.at(-1).events.length, runningCount,
    'A routine review-wait status must not append a timeline event');
  assert.equal(events.at(-1).prs[0].activity.at, runningState.activities[12].at,
    'The dashboard uses the actual runner step start');
  assert.equal(Object.hasOwn(events.at(-1).prs[0].activity, 'updatedAt'), false,
    'A new GPT review wait has no last-update timestamp');
  dashboard.recordBatchState(runningState);
  assert.equal(events.at(-1).events.length, runningCount, 'Repeated snapshots do not flood the activity log');
  assert.equal(events.at(-1).prs[0].activity.at, runningState.activities[12].at);
  assert.equal(Object.hasOwn(events.at(-1).prs[0].activity, 'updatedAt'), false);
  const progressState = { ...runningState, activities: { 12: {
    ...runningState.activities[12], message: 'GPT received a revised review prompt',
    updatedAt: '2026-10-27T15:00:45Z'
  } } };
  dashboard.recordBatchState(progressState);
  assert.equal(events.at(-1).prs[0].activity.at, runningState.activities[12].at,
    'Same-phase progress preserves the step start');
  assert.equal(events.at(-1).prs[0].activity.updatedAt, progressState.activities[12].updatedAt);
  const progressedCount = events.at(-1).events.length;
  dashboard.recordBatchState(progressState);
  assert.equal(events.at(-1).events.length, progressedCount, 'Repeated progress snapshots create no events');
  assert.equal(events.at(-1).prs[0].activity.updatedAt, progressState.activities[12].updatedAt,
    'Replaying a progress snapshot must not reset the last-update clock');
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
    pullRequests: [{ ...selection.pullRequests[0], headSha: nextSha, baseSha: 'b'.repeat(40) }],
    history: [{ number: 12, status: 'checks_failed', sourceHeadSha: sha }],
    deferred: [{ number: 12, reason: 'Integrated checks failed twice.' }] };
  const autoStart = actionLaunches.length;
  checkConclusion = null;
  dashboard.recordBatchState(repairState);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(actionLaunches.length, autoStart, 'An old failure cannot launch repair while the live head has pending checks');
  checkConclusion = 'failure';
  await dashboard.refresh({ force: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(actionLaunches.length, autoStart + 1, 'Launch once when the selected head still fails after the base advances');
  assert.equal(actionLaunches.at(-1)[4].headSha, nextSha);
  assert.equal(actionLaunches.at(-1)[4].baseSha, 'c'.repeat(40), 'CI repair uses the current base tip');
  assert.equal(actionLaunches.at(-1)[6], 'codex', 'Auto repair uses the configured method');
  dashboard.recordBatchState(repairState);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(actionLaunches.length, autoStart + 1, 'Polling cannot duplicate an auto-repair');
  await messageHandler({ type: 'auto-fix-ci', enabled: false });
  assert.equal(events.at(-1).autoFixCi, false);
  info = { ...info, mergeable: false, mergeable_state: 'dirty',base:{...info.base,sha:'d'.repeat(40)} };
  const conflictState = { ...repairState,
    pullRequests: repairState.pullRequests.map(pr => ({...pr, baseSha:'b'.repeat(40)})),
    history: [{ number: 12, status: 'needs_resolution', conflictPaths: ['feature.js'] }] };
  const beforeConflicts = actionLaunches.length;
  dashboard.recordBatchState(conflictState);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(actionLaunches.length, beforeConflicts, 'Conflict repair starts disabled');
  await messageHandler({ type: 'auto-fix-conflicts', enabled: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(events.at(-1).autoFixConflicts, true);
  assert.equal(actionLaunches.length, beforeConflicts + 1, 'Confirmed deferred conflicts open a repair task');
  assert.equal(actionLaunches.at(-1)[4].baseSha,'c'.repeat(40),
    'A batch base advanced by another merge must open conflict review against the current branch tip');
  assert.equal(actionLaunches.at(-1)[5].id, 'resolve-conflicts');
  assert.equal(actionLaunches.at(-1)[6], 'codex');
  dashboard.recordBatchState(conflictState);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(actionLaunches.length, beforeConflicts + 1, 'Polling cannot duplicate a conflict repair');
  const retryHead = 'e'.repeat(40);
  info = {...info, head:{...info.head, sha:retryHead}};
  const retryState = {...conflictState,
    pullRequests:conflictState.pullRequests.map(pr => ({...pr, headSha:retryHead}))};
  requestFault = Error('Temporary GitHub outage');
  dashboard.recordBatchState(retryState);
  await new Promise(resolve => setTimeout(resolve, 25));
  requestFault = undefined;
  launchResult = false;
  await dashboard.refresh({force:true});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(actionLaunches.length, beforeConflicts + 2,
    'Status refresh retries a repair whose validation failed');
  launchResult = true;
  await dashboard.refresh({force:true});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(actionLaunches.length, beforeConflicts + 3,
    'A canceled launch does not permanently consume the repair attempt');
  await dashboard.refresh({force:true});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(actionLaunches.length, beforeConflicts + 3,
    'A successful launch stays deduplicated on later refreshes');
  await messageHandler({ type: 'auto-fix-conflicts', enabled: false });
  assert.equal(events.at(-1).autoFixConflicts, false);
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
  assert(events.at(-1).events.some(event => event.message === 'PR was closed without merging'));
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
  const laggingWorkerState = { repository: selection.repository, deferred: [],
    workers: [{ id: 1, label: 'Oldest first', phase: 'Reviewing',
      numbers: [12], merged: 0, total: 1 }] };
  dashboard.recordBatchState(laggingWorkerState);
  assert.equal(events.at(-1).workers[0].merged, 0);
  dashboard.recordLocalResult({ repository: selection.repository,
    results: [{ number: 12, status: 'merged', merged: true, githubMerged: true, sha: 'c'.repeat(40) }] });
  assert.equal(events.at(-1).prs[0].state, 'merged', 'Verified merge results update the badge before polling');
  assert.equal(events.at(-1).workers[0].merged, 1,
    'Lane count uses verified PR state, not the lagging runner snapshot');
  assert.equal(events.at(-1).workers[0].merged,
    events.at(-1).prs.filter(pr => pr.state === 'merged').length,
    'The lane subtotal reconciles with the dashboard total');
  dashboard.recordBatchState(laggingWorkerState);
  assert.equal(events.at(-1).workers[0].merged, 1,
    'Replaying a stale worker snapshot cannot regress the displayed lane subtotal');
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
  info={...info,state:'closed',merged:false,merged_at:null};
  await dashboard.refresh({force:true});
  assert.equal(events.at(-1).prs[0].state,'closed','Explicit GitHub closure clears a stale merged badge');
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
  console.log('Live merge dashboard integration passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
