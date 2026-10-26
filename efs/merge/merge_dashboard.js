'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseReportOptions, stripReportOptions, blockerOptions, manualBlockerActions, dashboardActionPlan, launchBlockerAction } = require('./merge_blocker_actions');
const { createReactionChoices } = require('./merge_reaction_choices');
const { createMergeDashboardPersistence } = require('./merge_dashboard_persistence');
const { createLindseyReadFetch } = require('../github/github_read_api');

const REPORT_MARKER = '<!-- sweetiebot-merge-report -->';
const REVIEW_MARKER = '<!-- sweetiebot-merge-review -->';
const SHA = /^[0-9a-f]{40,64}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const TIMELINE_MODES = ['hidden', 'relative', 'clock'];

function branchDisplayLabel(branch, catalog) {
  if (branch === 'main') return '🏠';
  const pony = require('../github/pull_request').matchSweetiebotPonyCatalog(branch, catalog);
  return pony ? '✨ ' + (pony.name || require('../codex/pony_profile').displayName(pony.canonicalSlug)) : branch;
}

function ponyCatalog() {
  for (const file of [path.join(__dirname, '../branch_name_packs.json'),
    path.join(__dirname, '../../', 'scripts', 'branch_name_packs.json')]) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* Optional display enrichment. */ }
  }
  return undefined;
}

function configuredTimelineMode(vscode) {
  const value = vscode.workspace?.getConfiguration('scmToolkit')?.get('mergeTimelineTimestampMode', 'hidden');
  return TIMELINE_MODES.includes(value) ? value : 'hidden';
}

function configuredLayout(vscode) {
  const config = vscode.workspace?.getConfiguration('scmToolkit');
  const percent = (key, fallback, max) => {
    const value = config?.get(key, fallback);
    return Number.isInteger(value) && value >= 15 && value <= max ? value : fallback;
  };
  return {
    sidebar: percent('mergeSidebarWidthPercent', 37, 75),
    timeline: percent('mergeTimelineHeightPercent', 34, 80)
  };
}

function validateSelection(selection) {
  if (!REPO.test(selection?.repository || '') ||
      !Array.isArray(selection.pullRequests) ||
      selection.pullRequests.length < 1 || selection.pullRequests.length > 50) {
    throw new Error('Invalid bulk-merge dashboard selection.');
  }
  const numbers = new Set();
  return {
    repository: selection.repository,
    pullRequests: selection.pullRequests.map(pr => {
      const number = Number(pr?.number);
      if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number) ||
          !pr.title || !pr.head || !pr.base || !SHA.test(pr.headSha || '') ||
          pr.url !== 'https://github.com/' + selection.repository + '/pull/' + number) {
        throw new Error('Invalid or duplicate dashboard pull request.');
      }
      numbers.add(number);
      return {
        number, title: String(pr.title).slice(0, 300),
        url: pr.url, head: String(pr.head).slice(0, 255),
        base: String(pr.base).slice(0, 255), headSha: pr.headSha
      };
    })
  };
}

// Only current-head, current-base implementation choices should hold a PR in review.
function hasCurrentReviewDecision(body, scope) {
  if (!SHA.test(scope?.headSha || '') || !SHA.test(scope?.baseSha || '') ||
      String(body).includes('<!-- sweetiebot-merge-review-resolved -->')) return false;
  for (const match of String(body).matchAll(/<!--\s*sweetiebot-merge-options\s*\n([\s\S]*?)\n\s*-->/g)) {
    let payload;
    try { payload = JSON.parse(match[1]); } catch { continue; }
    if (payload?.version !== 1 || payload.headSha !== scope.headSha ||
        payload.baseSha !== scope.baseSha) continue;
    const choices = parseReportOptions(match[0]);
    if (new Set(choices.map(choice => choice.prompt.toLowerCase())).size >= 2) return true;
  }
  return false;
}

function reportFromComments(comments, scope = null) {
  let report = null;
  let review = null;
  const reviewNotes = [];
  for (const comment of comments || []) {
    const body = String(comment?.body || '');
    if (body.includes(REPORT_MARKER)) {
      report = { text: stripReportOptions(body.replace(REPORT_MARKER, '').replace('<!-- sweetiebot-generated-summary -->', '')).slice(0, 12000),
        options: parseReportOptions(body),
        url: comment.html_url || '', id: comment.id };
    }
    if (body.includes(REVIEW_MARKER) && (!scope || hasCurrentReviewDecision(body, scope))) {
      reviewNotes.push({ text: stripReportOptions(body.replace(REVIEW_MARKER, '').replace('<!-- sweetiebot-merge-analysis -->', '')).slice(0, 12000),
        options: parseReportOptions(body).map(option => comment.path && Number.isSafeInteger(comment.id)
          ? { ...option, sourceId: option.id, commentId: comment.id, id: 'report-' + comment.id + '-' + option.id.replace(/^report-/, '') } : option),
        url: comment.html_url || '', id: comment.id });
    }
  }
  if (reviewNotes.length) review = { ...reviewNotes.at(-1), text: reviewNotes.map(note => note.text).join('\n\n'), options: reviewNotes.flatMap(note => note.options) };
  const analysis = (comments || []).filter(comment => String(comment.body || '').startsWith('<!-- sweetiebot-merge-analysis -->')).map(comment => ({ text: stripReportOptions(comment.body.replace('<!-- sweetiebot-merge-analysis -->', '').replace(REVIEW_MARKER, '')), url: comment.html_url, path: comment.path }));
  return { report, review, analysis };
}

// Summarize GitHub code-review threads without trusting comment HTML or losing
// their original file locations when GitHub marks a diff position outdated.
function normalizeInlineReviewComments(comments) {
  const validLine = value => Number.isInteger(value) && value > 0 ? value : null;
  return (comments || []).filter(comment => typeof comment?.path === 'string' &&
    comment.path.trim()).map(comment => {
    const text = stripReportOptions(String(comment.body || '')
      .replaceAll(REVIEW_MARKER, '').replaceAll(REPORT_MARKER, '')).trim().slice(0, 12000);
    const firstLine = text.split('\n').map(line => line.trim()).find(Boolean) || 'Code review comment';
    const cleanTitle = firstLine.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)/, '').trim();
    const title = (cleanTitle || 'Code review comment').slice(0, 110);
    const line = validLine(comment.line) || validLine(comment.original_line);
    const startLine = validLine(comment.start_line) || validLine(comment.original_start_line);
    return {
      id: comment.id,
      path: comment.path,
      location: line ? (startLine && startLine !== line
        ? 'L' + startLine + '–L' + line : 'L' + line) : 'Line unavailable',
      outdated: !validLine(comment.line) && Boolean(validLine(comment.original_line)),
      title, text, author: String(comment.user?.login || ''),
      url: String(comment.html_url || '')
    };
  });
}

function mergePhase(pr, previous) {
  if (pr.merged || pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.state !== 'open') return 'blocked';
  if (pr.mergeable_state === 'dirty' || pr.mergeable === false) return 'conflict';
  if (previous.review) return 'review';
  if (pr.mergeable_state === 'unstable' || pr.mergeable_state === 'blocked') return 'blocked';
  if (previous.sawConflict && pr.mergeable === true && pr.head?.sha !== previous.originalHead) {
    return 'resolved';
  }
  if (pr.mergeable_state === 'queued') return 'queued';
  if (pr.head?.sha && pr.head.sha !== previous.originalHead) return 'updated';
  return 'waiting';
}

function normalizeFiles(files) {
  return (files || []).slice(0, 300).map(file => ({
    name: String(file.filename || ''),
    status: String(file.status || ''),
    additions: Number(file.additions || 0),
    deletions: Number(file.deletions || 0),
    patch: typeof file.patch === 'string' ? file.patch.slice(0, 16000) : ''
  }));
}

async function githubGet(fetchImpl, token, repository, endpoint) {
  const url = 'https://api.github.com/repos/' + repository + endpoint;
  const request = 'GitHub request failed: GET /repos/' + repository + endpoint;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  } catch (failure) {
    const causes = [failure, failure?.cause, ...(failure?.cause?.errors || [])];
    const reasons = {
      ENOTFOUND: 'Could not resolve api.github.com. Check your network or DNS settings.',
      EAI_AGAIN: 'DNS lookup temporarily failed. Retry the refresh.',
      ECONNREFUSED: 'The connection was refused. Check your proxy or firewall.',
      ECONNRESET: 'The connection was interrupted. Retry the refresh.',
      ETIMEDOUT: 'The connection timed out. Check your network and retry.',
      UND_ERR_CONNECT_TIMEOUT: 'Connecting to GitHub timed out. Check your network and retry.',
      UND_ERR_HEADERS_TIMEOUT: 'GitHub did not respond in time. Retry the refresh.',
      UND_ERR_SOCKET: 'The connection closed before the response completed. Retry the refresh.',
      CERT_HAS_EXPIRED: 'The TLS certificate has expired. Check your system clock and proxy.',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The TLS certificate could not be verified. Check your network or proxy certificate configuration.'
    };
    const code = causes.map(cause => cause?.code).find(code => Object.hasOwn(reasons, code));
    throw Error(request + '. ' + (code ? reasons[code] + ' (' + code + ')' :
      'No HTTP response was received. Check your network or proxy, then use Refresh GitHub status.'), { cause: failure });
  }
  if (!response.ok) {
    const hints = { 401: 'GitHub authentication was rejected. Sign in again.',
      403: 'GitHub denied access. Check repository permissions.',
      404: 'The repository or PR was not found, or your account cannot access it.',
      502: 'GitHub is temporarily unavailable. Retry the refresh.',
      503: 'GitHub is temporarily unavailable. Retry the refresh.' };
    throw await require('../github/github_rate_limit').githubResponseError(response,
      request + ' (HTTP ' + response.status + '). ' + (hints[response.status] || 'Retry the refresh; check GitHub status if this continues.'));
  }
  try { return await response.json(); }
  catch (failure) { throw Error(request + '. The response could not be read as JSON. Retry the refresh.', { cause: failure }); }
}

async function paged(fetchImpl, token, repository, endpoint, maxPages = 3) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const chunk = await githubGet(fetchImpl, token, repository,
      endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
    if (!Array.isArray(chunk)) throw new Error('GitHub returned an invalid list.');
    items.push(...chunk);
    if (chunk.length < 100) break;
  }
  return items;
}

async function readReports(fetchImpl, token, repository, number, maxPages = 2, scope = null) {
  const [conversation, inline, reviews] = await Promise.all([
    paged(fetchImpl, token, repository, '/issues/' + number + '/comments', maxPages),
    paged(fetchImpl, token, repository, '/pulls/' + number + '/comments', maxPages),
    paged(fetchImpl, token, repository, '/pulls/' + number + '/reviews', maxPages)
  ]);
  // Inline decision requests take precedence over legacy Conversation requests.
  return { ...reportFromComments([...conversation, ...inline], scope),
    inlineComments: inline, conversationComments: conversation, reviews };
}

// New GitHub review activity is observed separately from merge reports. GitHub
// review bodies, line comments, and Conversation comments have distinct APIs.
function postedReviewActivity(notes) {
  const entries = [];
  function include(entry, kind, message, location = '', skipMergeMarkers = false) {
    const body = String(entry?.body || '');
    if (!Number.isSafeInteger(entry?.id) || !body.trim() ||
        (skipMergeMarkers && (body.includes(REPORT_MARKER) || body.includes(REVIEW_MARKER)))) return;
    const author = /^[\w-]{1,39}$/.test(entry.user?.login || '') ? '@' + entry.user.login : '';
    const preview = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
    entries.push({ key: kind + ':' + entry.id, message,
      details: [author, location, preview].filter(Boolean).join(' · '),
      url: typeof entry.html_url === 'string' ? entry.html_url : '' });
  }
  for (const review of notes.reviews || []) {
    if (review.state !== 'PENDING') include(review, 'review', 'PR review submitted');
  }
  for (const comment of notes.inlineComments || []) {
    const line = Number.isSafeInteger(comment.line) ? comment.line : comment.original_line;
    const location = typeof comment.path === 'string'
      ? comment.path.slice(0, 180) + (Number.isSafeInteger(line) && line > 0 ? ':' + line : '') : '';
    include(comment, 'inline', 'Inline review comment posted', location, true);
  }
  for (const comment of notes.conversationComments || []) {
    include(comment, 'conversation', 'PR conversation comment posted', '', true);
  }
  return entries;
}

// Observe GitHub state and dispatch explicit user decisions. Never infer
// successful conflict resolution from an AI assertion or stale snapshot.
function startMergeDashboard(vscode, rawSelection, token, { fetchImpl = globalThis.fetch,
  initialRateLimit, intervalMs, setTimer = setInterval, clearTimer = clearInterval,
  context, rootUri, launchAction = launchBlockerAction, onFocusWorker = async () => {}, viewColumn = vscode.ViewColumn?.Two || 2 } = {}) {
  const selection = validateSelection(rawSelection);
  const readFetch = createLindseyReadFetch(selection.repository, { fetchImpl });
  const panel = vscode.window.createWebviewPanel('sweetiebot.bulkMergeDashboard',
    'Lindsey · Merge progress', viewColumn,
    { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = fs.readFileSync(path.join(__dirname, 'merge_dashboard.html'), 'utf8')
    .replaceAll('__NONCE__', nonce)
    .replaceAll('__CSP_SOURCE__', panel.webview.cspSource || '')
    .replace('__MARKDOWN_RENDERER__', fs.readFileSync(path.join(__dirname, 'merge_dashboard_markdown.js'), 'utf8'))
    .replace('__COMMIT_TREE__', fs.readFileSync(path.join(__dirname, 'merge_commit_tree.js'), 'utf8'))
    .replace('__ACTIVITY_RENDERER__', fs.readFileSync(path.join(__dirname, 'merge_dashboard_activity.js'), 'utf8'))
    .replace('__DIFF_RENDERER__', fs.readFileSync(path.join(__dirname, 'merge_dashboard_diff.js'), 'utf8'))
    .replace('__RATE_LIMIT_FORMATTER__', require('../github/github_rate_limit').rateLimitMessage.toString())
    .replace('__TIMESTAMP_FORMATTER__', fs.readFileSync(path.join(__dirname, 'merge_dashboard_timestamps.js'), 'utf8'));
  const catalog = ponyCatalog();
  const persistence = createMergeDashboardPersistence(context, selection);
  const prs = selection.pullRequests.map(pr => ({
    ...pr, originalHead: pr.headSha, currentHead: pr.headSha, state: 'waiting',
    headLabel: branchDisplayLabel(pr.head, catalog), baseLabel: branchDisplayLabel(pr.base, catalog),
    files: [], inlineReviewComments: [], commits: context?.workspaceState?.get('sweetiebot.prCommits.' + selection.repository + '.' + pr.number, []) || [], report: null, review: null, sawConflict: context?.workspaceState?.get('sweetiebot.sawConflict.' + selection.repository + '.' + pr.number + '.' + pr.headSha, false) === true, conflictCleared: context?.workspaceState?.get('sweetiebot.conflictCleared.' + selection.repository + '.' + pr.number + '.' + pr.headSha, false) === true, localRecovery: persistence.restoredRecovery[pr.number] || null,
    events: persistence.restoredEvents.filter(event => event.number === pr.number).slice(-35)
  }));
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  let workers = [];
  let disposed = false;
  let working = false;
  let activeRefresh = null;
  let queuedRefresh = null;
  let queuedForce = false;
  let cycle = 0;
  let rateLimitedUntil = initialRateLimit?.retryAt || 0;
  let error = initialRateLimit?.message || '';
  const events = [...persistence.restoredEvents];
  const launchingActions = new Set();
  const inlineComments = new Map();
  const observedReviewActivity = new Map();
  const reportedDeferrals = new Set();
  const reactionChoices = createReactionChoices({ repository: selection.repository, token, fetchImpl,
    storageDirectory: context?.globalStorageUri?.fsPath,
    launch: async (pr, comment, option, engine = 'web') => {
      if (disposed || launchingActions.has(pr.number)) return;
      launchingActions.add(pr.number);
      publish();
      try {
        const fresh = await githubGet(readFetch, token, selection.repository, '/pulls/' + pr.number);
        if (fresh.state !== 'open' || fresh.merged || fresh.merged_at || fresh.number !== pr.number ||
            fresh.html_url !== pr.url || fresh.base?.ref !== pr.base || fresh.base?.sha !== pr.baseSha ||
            fresh.head?.ref !== pr.head || fresh.head?.sha !== pr.headSha ||
            fresh.head?.repo?.full_name !== selection.repository) {
          throw Error('The PR changed after your reaction. Refresh the inline choices and react again.');
        }
        const snapshot = { ...pr, ...reportFromComments([comment]) };
        const opened = await launchAction(vscode, context, rootUri, selection.repository, snapshot, option, engine);
        addEvent(byNumber.get(pr.number), 'action', opened === false
          ? 'Reaction task was not opened; add a fresh reaction to retry.'
          : 'Your emoji selected: ' + option.label + ' · opened ' + (engine === 'web' ? 'GPT web' : 'Codex'));
      } finally {
        launchingActions.delete(pr.number);
        publish();
      }
    }
  });

  let nextEventId = 0;
  function addEvent(pr, state, message, details, url = '', commit = null) {
    const validCommit = SHA.test(commit?.sha || '');
    const event = { id: ++nextEventId, number: pr.number, state, message,
      ...(details ? { details } : {}),
      ...(url ? { url } : {}),
      ...(validCommit ? { commitSha: commit.sha,
        commitTitle: String(commit.title || '').split('\n')[0].slice(0, 160) } : {}),
      at: new Date().toISOString() };
    events.push(event);
    pr.events.push(event);
    if (events.length > 400) events.shift();
    if (pr.events.length > 35) pr.events.shift();
    persistence.recordEvent(event);
  }
  function publish() {
    if (disposed) return;
    void panel.webview.postMessage({
      type: 'state', repository: selection.repository, workers,
      rateLimitRetryAt: rateLimitedUntil,
      prs: prs.map(pr => ({ ...pr, blockerOptions: blockerOptions(pr), manualActions: manualBlockerActions(pr), actionPlan: dashboardActionPlan(pr), actionPending: launchingActions.has(pr.number) })), events, error,
      postSummaries: vscode.workspace?.getConfiguration('scmToolkit')?.get('mergePostSummaries', false) === true,
      selectedNumber: persistence.selectedNumber(),
      timestampMode: configuredTimelineMode(vscode),
      layoutPreferences: configuredLayout(vscode)
    });
  }

  function recordReviewActivity(item, notes) {
    const entries = postedReviewActivity(notes);
    const seen = observedReviewActivity.get(item.number);
    if (!seen) {
      // The first complete fetch establishes history; old PR comments are not new work.
      observedReviewActivity.set(item.number, new Set(entries.map(entry => entry.key)));
      return;
    }
    for (const entry of entries) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      // Only the selected PR's GitHub discussion URLs become timeline links.
      const url = entry.url.startsWith(item.url + '#') ||
        entry.url.startsWith(item.url + '/files#') ? entry.url : '';
      addEvent(item, 'review-comment', entry.message, entry.details, url);
    }
  }

  async function refreshOne(item) {
    let decisionComments = inlineComments.get(item.number) || [];
    const info = await githubGet(readFetch, token, selection.repository,
      '/pulls/' + item.number);
    // Never follow a moved PR base silently, and do not treat an unrelated PR as selected.
    if (info.number !== item.number || info.base?.ref !== item.base ||
        info.html_url !== item.url) {
      if (item.state !== 'blocked') {
        item.state = 'blocked';
        addEvent(item, 'blocked', 'PR identity or base changed; manual verification required');
      }
      publish();
      return;
    }
    const changed = info.head?.sha !== item.currentHead;
    const before = item.state;
    const previousMessage = item.statusMessage;
    if (changed) {
      item.currentHead = info.head?.sha || '';
      addEvent(item, 'updated', 'PR head changed; reviewing the new GitHub diff');
    }
    if (cycle === 1 || changed || !item.files.length) {
      const files = await paged(readFetch, token, selection.repository,
        '/pulls/' + item.number + '/files');
      try {
        item.commits = require('./merge_commit_tree').mergeCommitHistory(item.commits, await paged(readFetch, token, selection.repository, '/pulls/' + item.number + '/commits', 30));
        await context?.workspaceState?.update('sweetiebot.prCommits.' + selection.repository + '.' + item.number, item.commits);
        item.commitError = '';
      }
      catch (error) { if (error.rateLimited) throw error; item.commitError = error.message; }
      item.files = normalizeFiles(files);
      item.filesTruncated = files.length >= 300;
    }
    if (cycle === 1 || cycle % 3 === 0 || changed || info.merged || item.review) {
      const notes = await readReports(readFetch, token, selection.repository, item.number, 2,
        { headSha: info.head?.sha, baseSha: info.base?.sha });
      decisionComments = notes.inlineComments;
      inlineComments.set(item.number, decisionComments);
      recordReviewActivity(item, notes);
      if (notes.report?.id !== item.report?.id && notes.report) {
        addEvent(item, 'reported', 'AI merge explanation recorded on the pull request');
      }
      if (notes.review?.id !== item.review?.id && notes.review) {
        addEvent(item, 'review', 'A current implementation decision needs human judgment');
      } else if (item.review && !notes.review) {
        addEvent(item, 'updated', 'The previous review request is no longer active for this PR revision');
      }
      item.report = notes.report;
      item.review = notes.review;
      item.inlineReviewComments = normalizeInlineReviewComments(notes.inlineComments);
      item.analysis = notes.analysis;
    }
    const next = mergePhase(info, item);
    item.state = next;
    if (!item.conflictCleared && (item.sawConflict && ((info.mergeable === true && info.head?.sha !== item.originalHead) || next === 'merged'))) {
      item.conflictCleared = true;
      await context?.workspaceState?.update('sweetiebot.conflictCleared.' + selection.repository + '.' + item.number + '.' + item.originalHead, true);
    }
    if (next === 'conflict') {
      item.sawConflict = true;
      await context?.workspaceState?.update('sweetiebot.sawConflict.' + selection.repository + '.' + item.number + '.' + item.originalHead, true);
    }
    const labels = {
      merged: 'GitHub confirms the pull request was merged',
      closed: 'PR was closed without merging',
      resolved: 'Conflict cleared after head revision; awaiting merge',
      conflict: 'GitHub reports merge conflicts',
      review: 'Human review required',
      queued: 'GitHub reports the pull request is queued',
      blocked: info.state !== 'open' ? 'GitHub PR state is unavailable; merging is blocked'
        : info.mergeable_state === 'unstable' ? 'PR is open; checks are not passing'
        : 'PR is open; merging is blocked',
      updated: 'PR head differs from the selected snapshot',
      waiting: 'GitHub reports the PR is open; awaiting merge'
    };
    item.statusMessage = labels[next];
    if (before !== next || previousMessage !== item.statusMessage) {
      addEvent(item, next, item.statusMessage);
    }
    item.mergeable = info.mergeable;
    item.mergeableState = info.mergeable_state || '';
    item.mergedAt = info.merged_at || null;
    item.mergeCommit = info.merge_commit_sha || '';
    item.description = String(info.body || '').slice(0, 12000);
    publish();
    if (!launchingActions.has(item.number)) {
      await reactionChoices.inspect({ ...item, headSha: info.head?.sha, baseSha: info.base?.sha }, decisionComments);
    }
  }

  function refresh({ force = false } = {}) {
    if (disposed) return Promise.resolve();
    if (activeRefresh) {
      if (force) queuedForce = true;
      if (!queuedRefresh) queuedRefresh = activeRefresh.then(() => {
        const nextForce = queuedForce;
        queuedRefresh = null;
        queuedForce = false;
        return refresh({ force: nextForce });
      });
      return queuedRefresh;
    }
    activeRefresh = (async () => {
    if (working || disposed || Date.now() < rateLimitedUntil || (!require('../github/github_app_identity').separateAppsEnabled() &&
          require('../github/github_rate_limit').activeRateLimit(vscode)) || (!force && !isActive())) return;
    working = true;
    cycle++;
    error = '';
    try {
      // Limit simultaneous GitHub calls so selections of 50 PRs remain polite.
      const active = prs.filter(pr => force || pr.state !== 'merged');
      for (let start = 0; start < active.length && !disposed; start += 3) {
        await Promise.all(active.slice(start, start + 3).map(async pr => {
          try { await refreshOne(pr); }
          catch (failure) {
            error = failure.message;
            if (failure.rateLimited) {
              rateLimitedUntil = Math.max(rateLimitedUntil, failure.retryAt || Date.now() + 60000);
              void require('../github/github_rate_limit').promptRateLimit(vscode, failure, { context, retry: () => refresh({ force: true }) }).catch(() => {});
              rateLimitedUntil = Math.max(rateLimitedUntil, failure.retryAt);
            }
            if (pr.lastError !== failure.message) {
              pr.lastError = failure.message;
              addEvent(pr, 'error', 'Fetch failed', failure.message);
            }
          }
        }));
        if (rateLimitedUntil > Date.now()) break;
      }
    } finally {
      working = false;
      publish();
    }
    })().finally(() => { activeRefresh = null; });
    return activeRefresh;
  }

  panel.webview.onDidReceiveMessage(async message => {
    if (message?.type === 'focus-worker' && workers.some(worker => worker.id === message.number)) {
      return onFocusWorker(message.number);
    }
    if (message?.type === 'ready') return publish();
    if (message?.type === 'refresh') return refresh({ force: true });
    if (message?.type === 'select-pr') {
      if (Number.isSafeInteger(message.number) && byNumber.has(message.number)) persistence.select(message.number);
      return;
    }
    if (message?.type === 'post-summaries') {
      if (typeof message.enabled !== 'boolean') return;
      try {
        await vscode.workspace.getConfiguration('scmToolkit').update(
          'mergePostSummaries', message.enabled, vscode.ConfigurationTarget.Global);
      } catch (failure) { error = 'Could not save the AI summary preference: ' + failure.message; }
      publish();
      return;
    }
    if (message?.type === 'timestamp-mode') {
      if (!TIMELINE_MODES.includes(message.mode)) return;
      try {
        await vscode.workspace.getConfiguration('scmToolkit').update(
          'mergeTimelineTimestampMode', message.mode, vscode.ConfigurationTarget.Global);
      } catch (failure) {
        error = 'Could not save activity timeline time preference: ' + failure.message;
      }
      publish();
      return;
    }
    if (message?.type === 'open-link') {
      if (typeof message.url !== 'string' || message.url.length > 4096) return;
      let target;
      try { target = new URL(message.url); } catch { return; }
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) return;
      return vscode.env.openExternal(vscode.Uri.parse(target.href));
    }
    if (!Number.isSafeInteger(message?.number)) return;
    const pr = byNumber.get(message.number);
    if (!pr) return;
    if (message.type === 'blocker-action') {
      if (launchingActions.has(pr.number) || !['web', 'codex'].includes(message.engine || 'web')) return;
      launchingActions.add(pr.number);
      error = '';
      let reactionSelection;
      publish();
      try {
        const fresh = await githubGet(readFetch, token, selection.repository, '/pulls/' + pr.number);
        if (fresh.state !== 'open' || fresh.merged || fresh.merged_at ||
            fresh.number !== pr.number || fresh.html_url !== pr.url || fresh.base?.ref !== pr.base ||
            fresh.head?.ref !== pr.head || fresh.head?.sha !== message.headSha ||
            fresh.head?.repo?.full_name !== selection.repository) {
          throw Error('The PR changed. Refresh its status and review the options before choosing again.');
        }
        const notes = await readReports(readFetch, token, selection.repository, pr.number, 3,
          { headSha: fresh.head?.sha, baseSha: fresh.base?.sha });
        const snapshot = { ...pr, ...notes, headSha: fresh.head.sha, currentHead: fresh.head.sha,
          baseSha: fresh.base.sha, state: mergePhase(fresh, { ...pr, ...notes }) };
        const option = [...blockerOptions(snapshot), ...manualBlockerActions(snapshot)].find(item => item.id === message.actionId && item.key === message.optionKey);
        if (!option) throw Error('That implementation option changed. Refresh the report and choose again.');
        const engine = option.engine || message.engine || 'web';
        if (option.reaction) {
          const comment = notes.inlineComments.find(comment => (!option.commentId || comment.id === option.commentId) && parseReportOptions(comment.body).some(candidate => candidate.id === (option.sourceId || option.id) && candidate.prompt === option.prompt && candidate.reaction === option.reaction));
          if (!comment) throw Error('The code thread for this choice is no longer available.');
          await reactionChoices.select(snapshot, comment, option);
          addEvent(pr, 'action', 'Recorded your GitHub reaction: ' + option.label);
          reactionSelection = { snapshot, comment, engine };
        } else {
          const opened = await launchAction(vscode, context, rootUri, selection.repository, snapshot, option, engine);
          if (opened !== false) addEvent(pr, 'action', 'Opened ' + (engine === 'web' ? 'GPT web' : 'Codex branch workspace') + ': ' + option.label);
        }
      } catch (failure) {
        error = 'Could not start the selected implementation: ' + failure.message;
      } finally {
        launchingActions.delete(pr.number);
        publish();
      }
      if (reactionSelection) {
        try { await reactionChoices.inspect(reactionSelection.snapshot, [reactionSelection.comment], reactionSelection.engine); }
        catch (failure) { error = 'Your reaction was recorded, but its task could not start: ' + failure.message; publish(); }
      }
      return;
    }
    if (message.type === 'open-commit') {
      if (!pr.commits?.some(commit => commit.sha === message.url)) return;
      return require('../github/pr_workflows').openWorkflow(vscode,
        'https://github.com/' + selection.repository + '/commit/' + message.url, { openToSide: true });
    }
    if (message.type === 'open-pr' || message.type === 'open-diff') {
      const target = pr.url + (message.type === 'open-diff' ? '/files' : '');
      await require('../github/pr_workflows').openWorkflow(vscode, target, { openToSide: true });
    }
  });
  const config = () => vscode.workspace?.getConfiguration('scmToolkit');
  const isActive = () => panel.visible !== false && vscode.window.state?.focused !== false && config()?.get('mergeAutoRefresh', true) !== false;
  const refreshInterval = () => intervalMs || Math.max(30000, Math.min(3600000, Number(config()?.get('mergeRefreshIntervalSeconds', 120)) * 1000 || 120000));
  let actualInterval = refreshInterval();
  let timer = setTimer(() => { void refresh(); }, actualInterval);
  const visibilityListener = panel.onDidChangeViewState?.(() => { if (isActive()) void refresh(); });
  const focusListener = vscode.window.onDidChangeWindowState?.(() => { if (isActive()) void refresh(); });
  const configurationListener = vscode.workspace?.onDidChangeConfiguration?.(event => {
    if (event.affectsConfiguration('scmToolkit.mergeRefreshIntervalSeconds')) {
      clearTimer(timer); actualInterval = refreshInterval();
      timer = setTimer(() => { void refresh(); }, actualInterval);
    }
    if (['mergePostSummaries', 'mergeTimelineTimestampMode', 'mergeSidebarWidthPercent', 'mergeTimelineHeightPercent']
      .some(key => event.affectsConfiguration('scmToolkit.' + key))) publish();
  });
  panel.onDidDispose(() => {
    disposed = true;
    clearTimer(timer);
    configurationListener?.dispose(); visibilityListener?.dispose(); focusListener?.dispose();
  });
  publish();
  void refresh();
  return { panel, refresh, selection, flushLocalState: () => persistence.flush(), recordLocalProgress(event) {
    const pr = byNumber.get(event?.number);
    if (!pr) return;
    const stages = {
      preparing: 'Preparing PR in a temporary checkout',
      'message-prepared': 'Commit message validated against the selected PR and original contributors',
      integrating: 'Integrating the full PR with the current base',
      'applying-resolution': 'Applying the complete conflict-resolution patch',
      'rewrite-approved': 'Using an explicitly approved history rewrite as a last resort',
      prepared: 'Full PR squash prepared locally · not pushed yet',
      'decision-commit': 'Conflict decision recorded as a separate local commit',
      'sync-prepared': 'Branch synchronization prepared locally',
      pushed: 'Prepared commit pushed to the PR branch · not merged',
      'verifying-push': 'Verifying GitHub sees the pushed PR head',
      'waiting-checks': 'Checking the integrated PR head · waiting for passing checks',
      'checks-passed': 'Integrated-head checks passed · merge not yet confirmed',
      merging: 'Requesting GitHub merge · awaiting confirmation'
    };
    if (!Object.hasOwn(stages, event.stage)) return;
    const sha = SHA.test(event.sha || '') ? event.sha : '';
    const file = typeof event.path === 'string' && require('./merge_patch').safePatchPath(event.path) ? event.path : '';
    if (event.stage === 'preparing') {
      pr.lastPushedHead = '';
      if (typeof event.description === 'string' && event.description.trim()) {
        pr.localExplanation = event.description.trim().slice(0, 4000);
      }
    }
    if (event.stage === 'decision-commit' && file) {
      pr.localDecisions ||= {};
      pr.localDecisions[file] = { path: file, title: String(event.title || '').slice(0, 160),
        description: String(event.description || '').slice(0, 4000) };
    }
    if (event.stage === 'pushed') pr.lastPushedHead = sha;
    const decision = ['decision-commit', 'preparing', 'rewrite-approved', 'message-prepared'].includes(event.stage)
      ? [String(event.title || '').slice(0, 160), String(event.description || '').slice(0, 1000)].filter(Boolean).join('\n') : '';
    addEvent(pr, 'progress', stages[event.stage],
      [file, decision].filter(Boolean).join('\n'), '',
      sha ? { sha, title: event.title } : null);
    pr.localRecovery = persistence.recordRecovery(pr.number, pr.originalHead,
      event.stage, pr.lastPushedHead || '') || pr.localRecovery;
    publish();
    if (event.stage === 'pushed' || event.stage === 'checks-passed') void refresh();
  }, recordBatchState(state) {
    if (state?.repository !== selection.repository || !Array.isArray(state.deferred)) return;
    workers = (Array.isArray(state.workers) ? state.workers : []).filter(worker => Number.isInteger(worker.id) && worker.id > 0 && worker.id <= 3)
      .map(worker => ({ id: worker.id, label: String(worker.label || '').slice(0, 80),
        phase: String(worker.phase || '').slice(0, 80), merged: Number(worker.merged) || 0,
        total: Number(worker.total) || 0, numbers: (Array.isArray(worker.numbers) ? worker.numbers : []).filter(number => byNumber.has(number)) }));
    if (state.rateLimit) {
      rateLimitedUntil = Math.max(rateLimitedUntil, state.rateLimit.retryAt); error = state.rateLimit.message;
      if (rateLimitedUntil > Date.now()) void require('../github/github_rate_limit').promptRateLimit(vscode,
        Object.assign(Error(error), { rateLimited: true, retryAt: rateLimitedUntil, configured: true }),
        { context, retryPriority: 1, retry: () => vscode.commands.executeCommand('sweetiebot.mergeAllPullRequests') }).catch(() => {});
    }
    for (const item of state.history || []) {
      const pr = byNumber.get(item.number);
      if (!pr) continue;
      if (item.status === 'needs_resolution' || item.conflictPaths?.length) pr.sawConflict = true;
      if (typeof item.explanation === 'string' && item.explanation.trim()) {
        pr.localExplanation = item.explanation.trim().slice(0, 4000);
      }
      if (typeof item.reason === 'string') pr.localResultReason = item.reason.slice(0, 4000);
      for (const decision of item.decisions || []) {
        if (!require('./merge_patch').safePatchPath(decision?.path)) continue;
        pr.localDecisions ||= {};
        pr.localDecisions[decision.path] = { path: decision.path,
          title: String(decision.title || '').slice(0, 160), description: String(decision.description || '').slice(0, 4000) };
      }
    }
    for (const item of state.deferred) {
      const pr = byNumber.get(item.number);
      if (pr) {
        const paths = (state.history || []).filter(entry => entry.number === item.number).flatMap(entry => entry.conflictPaths || []);
        pr.localReview = require('./merge_blocker_report').blockerReport(pr, String(item.reason || 'Local integration stopped.'), paths, '', Object.values(pr.localDecisions || {}));
      }
    }
    for (const [number, report] of Object.entries(state.blockerReports || {})) {
      const pr = byNumber.get(Number(number));
      if (pr) pr.localReview = report;
    }
    for (const item of state.deferred) {
      const pr = byNumber.get(item.number);
      if (!pr || reportedDeferrals.has(item.number)) continue;
      reportedDeferrals.add(item.number);
      addEvent(pr, 'blocked', 'Deferred for this batch · other selected PRs can continue', String(item.reason || '').slice(0, 4000));
    }
    publish();
  }, recordLocalResult(result) {
    if (result?.repository !== selection.repository || !Array.isArray(result.results)) return;
    for (const failure of result.summaryErrors || []) {
      const pr = byNumber.get(failure.number);
      if (pr) addEvent(pr, 'error', 'Merge verified; optional GitHub summary was not posted', String(failure.error).slice(0, 1000));
    }
    for (const item of result.results) {
      const pr = byNumber.get(item.number);
      if (!pr) continue;
      if (typeof item.reason === 'string') pr.localResultReason = item.reason.slice(0, 4000);
      const continuing = ['synced', 'needs_resolution', 'needs_refresh', 'waiting'].includes(item.status);
      const pushed = SHA.test(item.preparedHead || '') ? item.preparedHead : pr.lastPushedHead;
      const message = item.status === 'merged' && item.merged === true ? 'Merge confirmed · destination commit ' + item.sha?.slice(0, 12)
        : item.status === 'synced' ? item.sha === item.previousHeadSha
          ? 'PR branch already up to date · no commit or push needed'
          : 'PR branch synchronized with incremental commits · existing history retained'
        : item.status === 'needs_resolution' ? 'Automatically reconciling overlapping changes against current main: ' + (item.conflictPaths || []).join(', ')
        : item.status === 'needs_refresh' ? 'Main advanced; automatically refreshing the integration.'
        : item.status === 'waiting' ? 'Checks still pending · prepared PR remains unmerged'
        : item.status === 'checks_failed' ? 'Integrated-head checks failed · PR remains unmerged'
        : pushed ? 'Stopped after pushing the prepared PR branch · merge not confirmed'
        : 'Local preparation stopped · merge not confirmed';
      const commitSha = item.status === 'merged' && item.merged === true && SHA.test(item.sha || '')
        ? item.sha : pushed;
      addEvent(pr, item.status === 'merged' && item.merged === true ? 'merged' : continuing ? 'updated' : 'blocked',
        message, String(item.reason || '').slice(0, 4000), '',
        commitSha ? { sha: commitSha, title: item.commitTitle } : null);
      pr.localRecovery = persistence.recordRecovery(pr.number, pr.originalHead,
        item.status, pushed || '') || pr.localRecovery;
    }
    publish();
    void refresh();
  } };
}

module.exports = { REPORT_MARKER, REVIEW_MARKER, validateSelection,
  reportFromComments, normalizeInlineReviewComments, mergePhase, normalizeFiles, githubGet, configuredTimelineMode, startMergeDashboard, branchDisplayLabel };
