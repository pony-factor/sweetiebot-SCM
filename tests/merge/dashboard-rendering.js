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
  const commitActivity = mergeActivityPresentation({ number: 12, commitSha: sha,
    commitTitle: '🔄 Sync branch to main', message: 'Requesting GitHub merge',
    details: 'Codex preserved both APIs.' });

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
  assert(fs.readFileSync(require('node:path').join(__dirname, '../../extension/merge/dashboard.html'),
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
  // Kefania and Lindsey share this renderer: emphasis inside link labels
  // must not leak Markdown markers or introduce nested clickable links.
  const formattedLinkRoot = document.createElement('div');
  const paperTitle = 'Does Confidential Proxy Voting Matter?';
  const paperUrl = 'https://www.nber.org/papers/w9126';
  renderMergeMarkdown(formattedLinkRoot, [
    '- **Confidential proxy voting:** Roberta Romano’s [*' + paperTitle +
      '* (NBER Working Paper No. 9126, September 2002)](' + paperUrl + ').',
    '- [**Bold** and ' + tick + 'code' + tick +
      ' and *italic https://tracker.invalid/path*](https://example.org/source)'
  ].join('\n'));
  const formattedNodes = walk(formattedLinkRoot);
  const formattedAnchors = formattedNodes.filter(n => n.tag === 'a');
  const paperLink = formattedAnchors.find(n => n.href === paperUrl);
  assert(paperLink, 'The linked paper remains clickable');
  assert.equal(paperLink.textContent,
    paperTitle + ' (NBER Working Paper No. 9126, September 2002)',
    'Markdown emphasis delimiters must not display in linked titles');
  assert(paperLink.children.some(n => n.tag === 'em' && n.textContent === paperTitle),
    'The paper title inside the hyperlink is italicized');
  const formattedLabel = formattedAnchors.find(n => n.href === 'https://example.org/source');
  assert(formattedLabel.children.some(n => n.tag === 'strong' && n.textContent === 'Bold'));
  assert(formattedLabel.children.some(n => n.tag === 'code' && n.textContent === 'code'));
  assert(formattedLabel.children.some(n => n.tag === 'em' &&
    n.textContent === 'italic https://tracker.invalid/path'));
  assert.equal(formattedAnchors.length, 2,
    'Raw URLs inside linked emphasis never create nested or tracking links');
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
  console.log('Dashboard API errors, Markdown, diffs and timestamps passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
