'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find(existsSync) || 'gh';

async function git(root, args) {
  return (await exec('git', args, { cwd: root, timeout: 20000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
function githubRepository(url) {
  const found = String(url || '').match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return found ? found[1] + '/' + found[2] : null;
}
async function reviewSyncConflicts(vscode, repository, details) {
  const { branch, defaultBranch, remote, head, target, strategy } = details;
  const root = repository.rootUri?.fsPath;
  if (!root || !SHA.test(head) || !SHA.test(target)) throw Error('Missing verified sync revisions.');
  const unchanged = async () => {
    await repository.status();
    if (repository.state.HEAD?.name !== branch
        || await git(root, ['rev-parse', 'HEAD']) !== head
        || await git(root, ['rev-parse', 'rextension/remotes/' + remote + '/' + defaultBranch]) !== target
        || await git(root, ['status', '--porcelain'])) {
      throw Error('Sync revisions or working files changed during review. No merge was started.');
    }
  };
  await unchanged();
  for (;;) {
    const choice = await vscode.window.showQuickPick([
      { id: 'inspect', label: '$(diff) Inspect conflict preview', description: 'Read Git conflict details; no files are changed' },
      { id: 'resolve', label: '$(tools) Start conflict resolution', description: 'Proceed to Git merge editor without auto-committing' },
      { id: 'own', label: '$(git-commit) Make my own commit first', description: 'Prefill an editable commit title and cancel this sync' },
      { id: 'cancel', label: '$(circle-slash) Cancel sync', description: 'Keep branch and working files unchanged' }
    ], { title: 'Review ' + defaultBranch + ' → ' + branch,
      placeHolder: 'Git cannot automatically reconcile this ' + strategy + ' sync', ignoreFocusOut: true });
    if (!choice || choice.id === 'cancel') return false;
    await unchanged();
    if (choice.id === 'own') {
      const suggested = '🛠️ Prepare ' + branch + ' for synchronization with ' + defaultBranch;
      const input = await vscode.window.showInputBox({
        title: 'Human-authored change before synchronization',
        prompt: 'Edit a suggested title. Stage and commit your own changes; Sweetiebot will not commit or push them.',
        value: suggested, ignoreFocusOut: true
      });
      if (input === undefined) return false;
      await unchanged();
      repository.inputBox.value = input.trim() || suggested;
      await vscode.commands.executeCommand('workbench.view.scm');
      return false;
    }
    if (choice.id === 'inspect') {
      let details = 'Git found conflicting changes.';
      try { await git(root, ['merge-tree', '--write-tree', head, target]); }
      catch (error) { details = String(error.stdout || error.stderr || error.message).slice(0, 30000); }
      const contents = ['Sync preflight review (no files changed)',
        'Branch: ' + branch + ' ' + head,
        'Incoming: ' + defaultBranch + ' ' + target,
        'Strategy: ' + strategy, '', details,
        '', 'Substantive edits require a separately reviewed human-authored commit.'].join('\n');
      const document = await vscode.workspace.openTextDocument({ content: contents, language: 'diff' });
      await vscode.window.showTextDocument(document, { preview: false });
    }
    if (choice.id === 'resolve') { await unchanged(); return true; }
  }
}

function reportBody(report) {
  const files = report.files.slice(0, 25)
    .map(name => '- ' + String(name).replace(/[\r\n\t]/g, ' ').replace(/[\x60]/g, "'")).join('\n');
  return ['**Sweetiebot routine sync report**', '',
    'Source: ' + report.defaultBranch + ' → ' + report.branch,
    'Strategy: ' + report.strategy,
    'Commit: ' + report.sha,
    'Automatic Git merge tree verified; no additional substantive edits were included.',
    '', 'Upstream changes incorporated (' + report.files.length + ' files):',
    files || '(no file changes)', '',
    'These file changes were inherited from upstream, not newly authored by the sync.',
    '<!-- sweetiebot-sync-report:' + report.sha + ' -->'].join('\n');
}
async function queueSyncReport(root, input) {
  const { before, sha, target, branch, defaultBranch, strategy, remote } = input;
  if (!SHA.test(before) || !SHA.test(sha) || !SHA.test(target) || before === sha) return false;
  const repo = githubRepository(await git(root, ['remote', 'get-url', remote]).catch(() => ''));
  if (!repo) return false;
  const parents = (await git(root, ['show', '-s', '--format=%P', sha])).split(/\s+/);
  if (parents[0] !== before || (strategy === 'merge' && !parents.includes(target))
      || (strategy === 'squash' && parents.length !== 1)) {
    throw Error('Refusing a sync report for an unverified commit ancestry.');
  }
  const files = (await git(root, ['diff', '--name-only', '-z', before, sha])).split('\0').filter(Boolean).slice(0, 50);
  const directory = path.join(await git(root, ['rev-parse', '--absolute-git-dir']), 'sweetiebot-sync-reports');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const record = { version: 1, repo, before, sha, target, branch, defaultBranch, strategy, remote, files };
  const file = path.join(directory, sha + '.json');
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return true;
}
async function githubApi(endpoint, method = 'GET', body) {
  const args = ['api', endpoint];
  if (method === 'POST') args.push('-X', 'POST', '-f', 'body=' + body);
  return JSON.parse((await exec(gh, args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout);
}
async function publishSyncReports(root, { api = githubApi, output } = {}) {
  const directory = path.join(await git(root, ['rev-parse', '--absolute-git-dir']), 'sweetiebot-sync-reports');
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let published = 0;
  for (const name of names.filter(item => /^[a-f0-9]{40}(?:[a-f0-9]{24})?\.json$/i.test(item)).slice(0, 5)) {
    const file = path.join(directory, name);
    const lock = file + '.lock';
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try {
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.size > 16000) continue;
      const report = JSON.parse(await fs.readFile(file, 'utf8'));
      if (report.version !== 1 || name !== report.sha + '.json'
          || !SHA.test(report.before) || !SHA.test(report.target)
          || !/^[\w.-]+\/[\w.-]+$/.test(report.repo || '')
          || !/^[\w./-]+$/.test(report.branch || '')
          || !Array.isArray(report.files) || report.files.length > 50) continue;
      if (githubRepository(await git(root, ['remote', 'get-url', report.remote]).catch(() => '')) !== report.repo) continue;
      const branch = report.branch.split('/').map(encodeURIComponent).join('/');
      const ref = await api('repos/' + report.repo + '/git/ref/heads/' + branch);
      if (ref?.object?.sha !== report.sha) continue; // Not yet pushed, or branch advanced.
      const endpoint = 'repos/' + report.repo + '/commits/' + report.sha + '/comments';
      const comments = await api(endpoint + '?per_page=100');
      if (!Array.isArray(comments) || comments.length >= 100) continue;
      const marker = '<!-- sweetiebot-sync-report:' + report.sha + ' -->';
      if (!comments.some(comment => String(comment.body || '').includes(marker))) {
        await api(endpoint, 'POST', reportBody(report));
      }
      await fs.unlink(file);
      output?.appendLine?.('Published verified sync report for ' + report.sha);
      published++;
    } catch (error) {
      output?.appendLine?.('Sync report remains pending: ' + String(error.message).slice(0, 200));
    } finally {
      await handle.close();
      await fs.rm(lock, { force: true });
    }
  }
  return published;
}
function registerSyncReportPublisher(vscode, context) {
  const output = vscode.window.createOutputChannel?.('Sweetiebot Sync Reports');
  if (output) context.subscriptions.push(output);
  let active = false, disposed = false;
  const poll = async () => {
    if (active || disposed) return;
    active = true;
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) return;
      for (const repository of (await extension.activate()).getAPI(1).repositories || []) {
        if (!repository.rootUri?.fsPath) continue;
        await publishSyncReports(repository.rootUri.fsPath, { output }).catch(error =>
          output?.appendLine?.('Sync reporting unavailable: ' + String(error.message).slice(0, 200)));
      }
    } finally { active = false; }
  };
  const timer = setInterval(() => { void poll().catch(() => {}); }, 60000);
  timer.unref?.();
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); } });
  void poll().catch(() => {});
}
module.exports = { githubRepository, reviewSyncConflicts, reportBody,
  queueSyncReport, publishSyncReports, registerSyncReportPublisher };
