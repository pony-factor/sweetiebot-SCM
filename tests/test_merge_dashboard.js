'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  REPORT_MARKER, REVIEW_MARKER, validateSelection, reportFromComments,
  mergePhase, normalizeFiles, githubGet, configuredTimelineMode, startMergeDashboard
} = require('../efs/merge_dashboard');
const { formatTimelineTimestamp } = require('../efs/merge_dashboard_timestamps');
const { renderMergeMarkdown } = require('../efs/merge_dashboard_markdown');
const { classifyMergePatchLine, renderMergePatch } = require('../efs/merge_dashboard_diff');

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
  const notes = reportFromComments(comments);
  assert.equal(notes.report.text, 'New report');
  assert.equal(notes.review.text, 'Need owner decision');
  assert.equal(mergePhase({ state: 'open', mergeable: false }, {}), 'conflict');
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
    env: { async openExternal(target) { openings.push(target); } }
  };
  let info = {
    number: 12, base: { ref: 'main' }, head: { sha }, html_url: url,
    state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty', body: 'Why this PR exists'
  };
  let commentsForPr = [];
  let fileRequests = 0;
  const fakeFetch = async (address, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const pathname = new URL(address).pathname;
    let result;
    if (pathname.endsWith('/pulls/12')) result = info;
    else if (pathname.endsWith('/files')) {
      fileRequests++;
      result = [{ filename: 'src/file.js', status: 'modified',
        additions: 5, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }];
    } else if (pathname.endsWith('/comments')) result = commentsForPr;
    else throw new Error('Unexpected URL ' + address);
    return { ok: true, json: async () => result };
  };
  const dashboard = startMergeDashboard(vscode, selection, 'test-token', {
    fetchImpl: fakeFetch,
    intervalMs: 25000,
    setTimer(callback) { pollCallback = callback; return 17; },
    clearTimer(id) { assert.equal(id, 17); stopped = true; }
  });
  assert.equal(dashboard.selection.pullRequests.length, 1);
  assert(panel.webview.html.includes('Lindsey · Bulk merge'));
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

  info = { ...info, head: { sha: nextSha }, mergeable: true, mergeable_state: 'clean' };
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
  info = { ...info, state: 'closed', merged: true, merged_at: '2026-10-20T12:00:00Z',
    merge_commit_sha: 'c'.repeat(40) };
  await dashboard.refresh();
  assert.equal(events.at(-1).prs[0].state, 'merged');
  assert(events.at(-1).events.some(event => event.state === 'merged'));
  disposeHandler();
  assert(stopped);
  assert(configurationDisposed);
  const countBefore = events.length;
  await dashboard.refresh();
  assert.equal(events.length, countBefore);

  await assert.rejects(githubGet(async () => ({ ok: false, status: 403 }), 'test-token',
    'pony-factor/example', '/pulls/12'), /HTTP 403/);
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
