'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');

const run = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/i;
const MARKER_PREFIX = '<!-- sweetiebot-pr-change-summary:';
const SYNC_SUBJECT = /^(?:🔄\s*)?Sync (?:brach|branch) to main(?:\s*\(#\d+\))?$/i;

function parsePullRequestUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw Error('Enter a full GitHub pull request URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
      url.username || url.password || url.search) {
    throw Error('Only HTTPS github.com pull request URLs are supported.');
  }
  const parts = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:\/)?$/);
  if (!parts || Number(parts[3]) > Number.MAX_SAFE_INTEGER) {
    throw Error('Use a GitHub pull request URL such as https://github.com/owner/repo/pull/123.');
  }
  const repository = parts[1] + '/' + parts[2];
  const number = Number(parts[3]);
  return { repository, number, url: 'https://github.com/' + repository + '/pull/' + number };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatChangeSummary(pr) {
  const subjects = [...new Set((Array.isArray(pr.commits) ? pr.commits : [])
    .map(commit => String(commit.messageHeadline || '').replace(/[\r\n]/g, ' ').trim())
    .filter(subject => subject && !SYNC_SUBJECT.test(subject)))].slice(0, 16);
  const areas = [...new Set((Array.isArray(pr.files) ? pr.files : []).map(file => {
    const filename = String(file.path || '').replace(/[\r\n]/g, '');
    const parts = filename.split('/');
    return parts.length > 2 ? parts.slice(0, 2).join('/') + '/' : filename;
  }).filter(Boolean))].slice(0, 12);
  const body = ['### Changes', '',
    ...(subjects.length ? subjects.map(subject => '- ' + subject.slice(0, 220))
      : ['- Summarize the implementation changes here.'])];
  const tick = String.fromCharCode(96);
  if (areas.length) body.push('', '### Files and areas touched', '',
    ...areas.map(area => '- ' + tick + area.replaceAll(tick, '') + tick));
  return body.join('\n');
}

async function gh(args) {
  const executable = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(fs.existsSync) || 'gh';
  const { stdout } = await run(executable, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  return stdout.trim();
}

async function ghJson(args, execute = gh) {
  try { return JSON.parse(await execute(args)); }
  catch (error) { throw Error('Could not read a GitHub CLI response: ' + error.message); }
}

async function readPullRequest(value, execute = gh) {
  const target = parsePullRequestUrl(value);
  const pr = await ghJson(['pr', 'view', target.url, '--json',
    'url,title,headRefOid,baseRefName,state,commits,files'], execute);
  const actual = parsePullRequestUrl(pr.url);
  if (actual.repository.toLowerCase() !== target.repository.toLowerCase() ||
      actual.number !== target.number || !SHA.test(pr.headRefOid || '')) {
    throw Error('GitHub returned a different pull request or an invalid head revision.');
  }
  if (pr.state !== 'OPEN') throw Error('Only an open pull request can receive a new change summary.');
  return { ...pr, url: actual.url, repository: actual.repository, number: actual.number };
}

async function publishChangeSummary({ url, headSha, body }, execute = gh) {
  if (!SHA.test(headSha || '') || typeof body !== 'string' ||
      !body.trim() || body.length > 10000) {
    throw Error('Supply a nonempty summary (up to 10,000 characters) for a verified PR revision.');
  }
  const fresh = await readPullRequest(url, execute);
  if (fresh.headRefOid !== headSha) {
    throw Error('The PR head changed while the summary was being edited. Reopen the form and review the new changes.');
  }
  const author = await ghJson(['api', 'user'], execute);
  if (typeof author.login !== 'string' || !author.login) {
    throw Error('Sign in to GitHub CLI before posting a PR summary.');
  }
  const endpoint = 'repos/' + fresh.repository + '/issues/' + fresh.number + '/comments';
  const marker = MARKER_PREFIX + headSha + ' -->';
  for (let page = 1; page <= 20; page++) {
    const comments = await ghJson(['api', endpoint + '?per_page=100&page=' + page], execute);
    if (!Array.isArray(comments)) throw Error('GitHub returned an invalid PR comment list.');
    const prior = comments.find(comment =>
      comment.user?.login?.toLowerCase() === author.login.toLowerCase() &&
      typeof comment.body === 'string' && comment.body.includes(marker));
    if (prior) return { alreadyPosted: true, url: prior.html_url || fresh.url };
    if (comments.length < 100) break;
    if (page === 20) throw Error('Too many prior comments to check for an existing summary safely.');
  }
  const posted = await ghJson(['api', '-X', 'POST', endpoint,
    '-f', 'body=' + body.trim() + '\n\n' + marker], execute);
  let commentUrl;
  try { commentUrl = new URL(posted.html_url); } catch { /* Invalid GitHub response. */ }
  const commentPath = '/' + fresh.repository + '/';
  if (commentUrl?.protocol !== 'https:' || commentUrl.hostname !== 'github.com' ||
      ![commentPath + 'pull/' + fresh.number, commentPath + 'issues/' + fresh.number].includes(commentUrl.pathname) ||
      !/^#issuecomment-[0-9]+$/.test(commentUrl.hash)) {
    throw Error('GitHub did not confirm the created PR conversation comment.');
  }
  return { alreadyPosted: false, url: posted.html_url };
}

async function openChangeSummaryForm(vscode, suppliedUrl, { execute = gh } = {}) {
  const url = typeof suppliedUrl === 'string' && suppliedUrl.trim()
    ? suppliedUrl : await vscode.window.showInputBox({
      title: 'Post a change summary to an existing PR',
      prompt: 'Paste the upstream PR URL. Sweetiebot will use your local GitHub CLI account.',
      placeHolder: 'https://github.com/owner/repository/pull/123',
      ignoreFocusOut: true
    });
  if (!url) return null;
  const pr = await readPullRequest(url, execute);
  const panel = vscode.window.createWebviewPanel('sweetiebot.changeSummary',
    'PR #' + pr.number + ' · Change summary', vscode.ViewColumn.Active || 1,
    { enableScripts: true, retainContextWhenHidden: true });
  const nonce = randomBytes(16).toString('hex');
  panel.webview.html = fs.readFileSync(path.join(__dirname, '../ui/pr-change-summary.html'), 'utf8')
    .replaceAll('__NONCE__', nonce)
    .replaceAll('__CSP_SOURCE__', panel.webview.cspSource || '')
    .replaceAll('__PR_TITLE__', escapeHtml(pr.title || 'Pull request #' + pr.number))
    .replaceAll('__PR_URL__', escapeHtml(pr.url))
    .replaceAll('__PR_HEAD__', escapeHtml(pr.headRefOid.slice(0, 12)))
    .replaceAll('__SUMMARY__', escapeHtml(formatChangeSummary(pr)));
  let posting = false;
  panel.webview.onDidReceiveMessage(async message => {
    if (message?.type !== 'post' || posting) return;
    posting = true;
    try {
      const result = await publishChangeSummary({
        url: pr.url, headSha: pr.headRefOid, body: message.body
      }, execute);
      await panel.webview.postMessage({ type: 'posted', alreadyPosted: result.alreadyPosted });
      const choice = await vscode.window.showInformationMessage(
        result.alreadyPosted ? 'A summary for this PR revision is already posted.'
          : 'Posted a PR conversation summary using your GitHub CLI account.',
        'Open comment');
      if (choice === 'Open comment') await vscode.env.openExternal(vscode.Uri.parse(result.url));
    } catch (error) {
      await panel.webview.postMessage({ type: 'error', message: error.message });
    } finally { posting = false; }
  });
  return panel;
}

function registerChangeSummaryCommand(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand(
    'sweetiebot.postPullRequestChangeSummary', url =>
      openChangeSummaryForm(vscode, url).catch(error =>
        vscode.window.showErrorMessage('Could not prepare PR summary: ' + error.message))));
}

module.exports = { parsePullRequestUrl, formatChangeSummary, readPullRequest,
  publishChangeSummary, openChangeSummaryForm, registerChangeSummaryCommand, MARKER_PREFIX };
