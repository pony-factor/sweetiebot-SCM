'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseReportOptions, stripReportOptions, blockerOptions, launchBlockerAction } = require('./merge_blocker_actions');
const { createReactionChoices } = require('./merge_reaction_choices');

const REPORT_MARKER = '<!-- sweetiebot-merge-report -->';
const REVIEW_MARKER = '<!-- sweetiebot-merge-review -->';
const SHA = /^[0-9a-f]{40,64}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const TIMELINE_MODES = ['hidden', 'relative', 'clock'];

function branchDisplayLabel(branch, catalog) {
  if (branch === 'main') return '🏠';
  const pony = require('./pull_request').matchSweetiebotPonyCatalog(branch, catalog);
  return pony ? '✨ ' + (pony.name || require('./pony_profile').displayName(pony.canonicalSlug)) : branch;
}

function ponyCatalog() {
  for (const file of [path.join(__dirname, 'branch_name_packs.json'),
    path.join(__dirname, '..', 'scripts', 'branch_name_packs.json')]) {
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

function reportFromComments(comments) {
  let report = null;
  let review = null;
  for (const comment of comments || []) {
    const body = String(comment?.body || '');
    if (body.includes(REPORT_MARKER)) {
      report = { text: stripReportOptions(body.replace(REPORT_MARKER, '')).slice(0, 12000),
        options: parseReportOptions(body),
        url: comment.html_url || '', id: comment.id };
    }
    if (body.includes(REVIEW_MARKER)) {
      review = { text: stripReportOptions(body.replace(REVIEW_MARKER, '')).slice(0, 12000),
        options: parseReportOptions(body),
        url: comment.html_url || '', id: comment.id };
    }
  }
  return { report, review };
}

function mergePhase(pr, previous) {
  if (pr.merged || pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.state !== 'open') return 'blocked';
  if (pr.mergeable_state === 'dirty' || pr.mergeable === false) return 'conflict';
  if (previous.review && !previous.report) return 'review';
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
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) {
    const error = new Error('GitHub refresh failed (HTTP ' + response.status + ').');
    if (response.status === 403 || response.status === 429) error.rateLimited = true;
    throw error;
  }
  return response.json();
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

async function readReports(fetchImpl, token, repository, number, maxPages = 2) {
  const [conversation, inline] = await Promise.all([
    paged(fetchImpl, token, repository, '/issues/' + number + '/comments', maxPages),
    paged(fetchImpl, token, repository, '/pulls/' + number + '/comments', maxPages)
  ]);
  // Inline decision requests take precedence over legacy Conversation requests.
  return { ...reportFromComments([...conversation, ...inline]), inlineComments: inline };
}

// Observe GitHub state and dispatch explicit user decisions. Never infer
// successful conflict resolution from an AI assertion or stale snapshot.
function startMergeDashboard(vscode, rawSelection, token, { fetchImpl = globalThis.fetch,
  intervalMs, setTimer = setInterval, clearTimer = clearInterval,
  context, rootUri, launchAction = launchBlockerAction } = {}) {
  const selection = validateSelection(rawSelection);
  const panel = vscode.window.createWebviewPanel('sweetiebot.bulkMergeDashboard',
    'Lindsey · Merge progress', vscode.ViewColumn?.Two || 2,
    { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = fs.readFileSync(path.join(__dirname, 'merge_dashboard.html'), 'utf8')
    .replaceAll('__NONCE__', nonce)
    .replaceAll('__CSP_SOURCE__', panel.webview.cspSource || '')
    .replace('__MARKDOWN_RENDERER__', fs.readFileSync(path.join(__dirname, 'merge_dashboard_markdown.js'), 'utf8'))
    .replace('__DIFF_RENDERER__', fs.readFileSync(path.join(__dirname, 'merge_dashboard_diff.js'), 'utf8'))
    .replace('__TIMESTAMP_FORMATTER__', fs.readFileSync(path.join(__dirname, 'merge_dashboard_timestamps.js'), 'utf8'))
    .replace('__COMMIT_TREE__', fs.readFileSync(path.join(__dirname, 'merge_commit_tree.js'), 'utf8'));
  const catalog = ponyCatalog();
  const prs = selection.pullRequests.map(pr => ({
    ...pr, originalHead: pr.headSha, currentHead: pr.headSha, state: 'waiting',
    headLabel: branchDisplayLabel(pr.head, catalog), baseLabel: branchDisplayLabel(pr.base, catalog),
    files: [], report: null, review: null, sawConflict: false, commits: [], events: []
  }));
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  let disposed = false;
  let working = false;
  let batchStatus = '';
  let cycle = 0;
  let rateLimitedUntil = 0;
  let error = '';
  const events = [];
  const launchingActions = new Set();
  const inlineComments = new Map();
  const reportedDeferrals = new Set();
  const reactionChoices = createReactionChoices({ repository: selection.repository, token, fetchImpl,
    storageDirectory: context?.globalStorageUri?.fsPath,
    launch: async (pr, comment, option) => {
      if (disposed || launchingActions.has(pr.number)) return;
      launchingActions.add(pr.number);
      publish();
      try {
        const fresh = await githubGet(fetchImpl, token, selection.repository, '/pulls/' + pr.number);
        if (fresh.state !== 'open' || fresh.merged || fresh.merged_at || fresh.number !== pr.number ||
            fresh.html_url !== pr.url || fresh.base?.ref !== pr.base || fresh.base?.sha !== pr.baseSha ||
            fresh.head?.ref !== pr.head || fresh.head?.sha !== pr.headSha ||
            fresh.head?.repo?.full_name !== selection.repository) {
          throw Error('The PR changed after your reaction. Refresh the inline choices and react again.');
        }
        const snapshot = { ...pr, ...reportFromComments([comment]) };
        const opened = await launchAction(vscode, context, rootUri, selection.repository, snapshot, option, 'web');
        addEvent(byNumber.get(pr.number), 'action', opened === false
          ? 'Reaction task was not opened; add a fresh reaction to retry.'
          : 'Your emoji selected: ' + option.label + ' · opened GPT web');
      } finally {
        launchingActions.delete(pr.number);
        publish();
      }
    }
  });

  function addEvent(pr, state, message, details) {
    const event = { number: pr.number, state, message, ...(details ? { details } : {}), at: new Date().toISOString() };
    events.push(event);
    pr.events.push(event);
    if (events.length > 400) events.shift();
    if (pr.events.length > 35) pr.events.shift();
  }
  function publish() {
    if (disposed) return;
    void panel.webview.postMessage({
      type: 'state', repository: selection.repository, batchStatus,
      prs: prs.map(pr => ({ ...pr, blockerOptions: blockerOptions(pr), actionPending: launchingActions.has(pr.number) })), events, error,
      timestampMode: configuredTimelineMode(vscode),
      layoutPreferences: configuredLayout(vscode),
      nextRefreshSeconds: Math.ceil(actualInterval / 1000)
    });
  }

  async function refreshOne(item) {
    let decisionComments = inlineComments.get(item.number) || [];
    const info = await githubGet(fetchImpl, token, selection.repository,
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
      if (cycle > 1) item.localBlocker = '';
      item.currentHead = info.head?.sha || '';
      addEvent(item, 'updated', 'PR head changed; reviewing the new GitHub diff');
    }
    if (cycle === 1 || changed || !item.files.length) {
      const files = await paged(fetchImpl, token, selection.repository,
        '/pulls/' + item.number + '/files');
      try {
        item.commits = require('./merge_commit_tree').mergeCommitHistory(item.commits, await paged(fetchImpl, token, selection.repository, '/pulls/' + item.number + '/commits', 30));
        item.commitError = '';
      } catch (failure) { if (failure.rateLimited) throw failure; item.commitError = failure.message; }
      item.files = normalizeFiles(files);
      item.filesTruncated = files.length >= 300;
    }
    if (cycle === 1 || cycle % 3 === 0 || changed || info.merged) {
      const notes = await readReports(fetchImpl, token, selection.repository, item.number);
      decisionComments = notes.inlineComments;
      inlineComments.set(item.number, decisionComments);
      if (notes.report?.id !== item.report?.id && notes.report) {
        addEvent(item, 'reported', 'AI merge explanation recorded on the pull request');
      }
      if (notes.review?.id !== item.review?.id && notes.review) {
        addEvent(item, 'review', 'Human judgment requested on the pull request');
      }
      item.report = notes.report;
      item.review = notes.review;
    }
    const next = mergePhase(info, item);
    item.state = next;
    if (next === 'conflict') item.sawConflict = true;
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

  async function refresh() {
    if (working || disposed || Date.now() < rateLimitedUntil) return;
    working = true;
    cycle++;
    error = '';
    try {
      // Limit simultaneous GitHub calls so selections of 50 PRs remain polite.
      for (let start = 0; start < prs.length && !disposed; start += 3) {
        await Promise.all(prs.slice(start, start + 3).map(async pr => {
          try { await refreshOne(pr); }
          catch (failure) {
            error = failure.message;
            if (failure.rateLimited) rateLimitedUntil = Date.now() + 120000;
            if (pr.lastError !== failure.message) {
              pr.lastError = failure.message;
              addEvent(pr, 'error', failure.message);
            }
          }
        }));
        if (rateLimitedUntil > Date.now()) break;
      }
    } finally {
      working = false;
      publish();
    }
  }

  panel.webview.onDidReceiveMessage(async message => {
    if (message?.type === 'ready') return publish();
    if (message?.type === 'refresh') return refresh();
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
      publish();
      try {
        const fresh = await githubGet(fetchImpl, token, selection.repository, '/pulls/' + pr.number);
        if (fresh.state !== 'open' || fresh.merged || fresh.merged_at ||
            fresh.number !== pr.number || fresh.html_url !== pr.url || fresh.base?.ref !== pr.base ||
            fresh.head?.ref !== pr.head || fresh.head?.sha !== message.headSha ||
            fresh.head?.repo?.full_name !== selection.repository) {
          throw Error('The PR changed. Refresh its status and review the options before choosing again.');
        }
        const notes = await readReports(fetchImpl, token, selection.repository, pr.number, 3);
        const snapshot = { ...pr, ...notes, headSha: fresh.head.sha, currentHead: fresh.head.sha,
          state: mergePhase(fresh, { ...pr, ...notes }) };
        const option = blockerOptions(snapshot).find(item => item.id === message.actionId && item.key === message.optionKey);
        if (!option) throw Error('That implementation option changed. Refresh the report and choose again.');
        const engine = option.engine || message.engine || 'web';
        const opened = await launchAction(vscode, context, rootUri, selection.repository, snapshot, option, engine);
        if (opened !== false) addEvent(pr, 'action', 'Opened ' + (engine === 'web' ? 'GPT web' : 'Codex branch workspace') + ': ' + option.label);
      } catch (failure) {
        error = 'Could not start the selected implementation: ' + failure.message;
      } finally {
        launchingActions.delete(pr.number);
        publish();
      }
      return;
    }
    if (message.type === 'open-commit') {
      if (!pr.commits?.some(commit => commit.sha === message.url)) return;
      return vscode.env.openExternal(vscode.Uri.parse('https://github.com/' + selection.repository + '/commit/' + message.url));
    }
    if (message.type === 'open-pr' || message.type === 'open-diff') {
      const target = pr.url + (message.type === 'open-diff' ? '/files' : '');
      await vscode.env.openExternal(vscode.Uri.parse(target));
    }
  });
  const actualInterval = intervalMs || Math.max(15000, prs.length * 4000);
  const timer = setTimer(() => { void refresh(); }, actualInterval);
  const configurationListener = vscode.workspace?.onDidChangeConfiguration?.(event => {
    if (['mergeTimelineTimestampMode', 'mergeSidebarWidthPercent', 'mergeTimelineHeightPercent']
      .some(key => event.affectsConfiguration('scmToolkit.' + key))) publish();
  });
  panel.onDidDispose(() => {
    disposed = true;
    clearTimer(timer);
    configurationListener?.dispose();
  });
  publish();
  void refresh();
  return { panel, refresh, selection, recordLocalProgress(event) {
    const pr = byNumber.get(event?.number);
    if (!pr) return;
    const stages = {
      preparing: 'Preparing the full PR in an isolated checkout',
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
    if (event.stage === 'preparing') { pr.lastPushedHead = ''; pr.localBlocker = ''; batchStatus = 'Local merge is running'; }
    if (event.stage === 'pushed') pr.lastPushedHead = sha;
    const decision = ['decision-commit', 'preparing', 'rewrite-approved'].includes(event.stage)
      ? [String(event.title || '').slice(0, 160), String(event.description || '').slice(0, 1000)].filter(Boolean).join('\n') : '';
    addEvent(pr, 'progress', stages[event.stage],
      [[file, sha && 'Commit: ' + sha.slice(0, 12)].filter(Boolean).join(' · '), decision].filter(Boolean).join('\n'));
    publish();
  }, recordBatchState(state) {
    if (state?.repository !== selection.repository || !Array.isArray(state.deferred)) return;
    const settled = new Set([...(state.merged || []), ...state.deferred].map(item => item.number));
    const finished = prs.every(pr => settled.has(pr.number));
    batchStatus = finished ? 'Batch finished · no merge is running; review the remaining blockers'
      : 'Batch is processing the remaining pull requests';
    for (const item of state.deferred) {
      const pr = byNumber.get(item.number);
      if (pr) pr.localBlocker = String(item.reason || 'Local integration stopped.').slice(0, 4000);
      if (!pr || reportedDeferrals.has(item.number)) continue;
      reportedDeferrals.add(item.number);
      addEvent(pr, 'blocked', 'Deferred for this batch · other selected PRs can continue', String(item.reason || '').slice(0, 4000));
    }
    publish();
  }, recordLocalResult(result) {
    if (result?.repository !== selection.repository || !Array.isArray(result.results)) return;
    if (prs.every(pr => result.results.some(item => item.number === pr.number && !['synced', 'needs_resolution', 'needs_refresh', 'waiting'].includes(item.status)))) batchStatus = 'Local merge finished · no merge is running';
    for (const item of result.results) {
      const pr = byNumber.get(item.number);
      if (!pr) continue;
      pr.localBlocker = ['blocked', 'checks_failed'].includes(item.status) ? String(item.reason || 'Local integration stopped.').slice(0, 4000) : '';
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
      const details = [pushed && 'Pushed commit: ' + pushed.slice(0, 12), item.reason, item.summaryWarning].filter(Boolean).join('\n');
      addEvent(pr, item.status === 'merged' && item.merged === true ? 'merged' : continuing ? 'updated' : 'blocked', message, details);
    }
    publish();
  } };
}

module.exports = { REPORT_MARKER, REVIEW_MARKER, validateSelection,
  reportFromComments, mergePhase, normalizeFiles, githubGet, configuredTimelineMode, startMergeDashboard, branchDisplayLabel };
