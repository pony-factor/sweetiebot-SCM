'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { renderSpellcheckDiff } = require('./spellcheck_diff');

const execFileAsync = promisify(execFile);
const NOTICE_NAME = 'sweetiebot-spellcheck-ready.json';
const DEFAULT_EMAIL = '326443430+codex-pony[bot]@users.noreply.github.com';
const NOREPLY_EMAIL = /^(?:[1-9]\d*\+)?[a-z\d-]+(?:\[bot\])?@users\.noreply\.github\.com$/i;
const SHA = /^[a-f\d]{40,64}$/i;

function parseNotice(content) {
  if (typeof content !== 'string' || content.length > 16384) return null;
  try {
    const data = JSON.parse(content);
    if (data?.version !== 1 || typeof data.head !== 'string' || !SHA.test(data.head)
        || !Array.isArray(data.paths) || !data.paths.length || data.paths.length > 100) return null;
    const paths = [];
    for (const file of data.paths) {
      if (typeof file !== 'string' || !file || file.length > 1024
          || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')
          || !/\.mdx?$/i.test(file)) return null;
      if (!paths.includes(file)) paths.push(file);
    }
    if (data.model !== undefined && (typeof data.model !== 'string' || !data.model.trim()
        || data.model.length > 200 || /[\r\n<>]/.test(data.model))) return null;
    if (data.title !== undefined && (typeof data.title !== 'string' || !data.title.startsWith('Spellcheck ')
        || data.title.length > 72 || /[\r\n<>]/.test(data.title)
        || data.title.trim().split(/\s+/).length < 4 || data.title.trim().split(/\s+/).length > 6)) return null;
    return { head: data.head, paths, ...(data.model ? { model: data.model.trim() } : {}), ...(data.title ? { title: data.title.trim() } : {}) };
  } catch { return null; }
}

function coauthor(email = DEFAULT_EMAIL, model = '') {
  const name = model ? 'Ollama (' + model + ')' : 'Ollama';
  if (typeof email !== 'string' || !NOREPLY_EMAIL.test(email.trim())) return '';
  if (typeof name !== 'string' || !name.trim() || /[\r\n<>]/.test(name)) return '';
  return 'Co-authored-by: ' + name.trim() + ' <' + email.trim() + '>';
}

function spellcheckMessage(paths, email = DEFAULT_EMAIL, model = '', title = '') {
  const count = paths.length;
  const subject = '🤖 ' + (title || 'Spellcheck ' + count + ' Markdown file' + (count === 1 ? '' : 's'));
  const trailer = coauthor(email, model);
  return subject + (trailer ? '\n\n' + trailer : '');
}

async function git(cwd, args) {
  return (await execFileAsync('git', args, { cwd, timeout: 10000 })).stdout.trim();
}

async function takeNotice(repository, dependencies = {}) {
  const io = dependencies.fs || fs;
  const run = dependencies.git || git;
  const root = repository.rootUri?.fsPath;
  if (!root) return null;

  const gitdir = await run(root, ['rev-parse', '--absolute-git-dir']);
  if (!path.isAbsolute(gitdir)) return null;
  const source = path.join(gitdir, NOTICE_NAME);
  const destination = source + '.claimed-' + process.pid + '-' + Math.random().toString(36).slice(2);
  try {
    // Atomic rename claims the event in one window even if several are open.
    await io.rename(source, destination);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const metadata = await io.lstat(destination);
    if (!metadata.isFile() || metadata.size > 16384) return null;
    const notice = parseNotice(await io.readFile(destination, 'utf8'));
    if (!notice || await run(root, ['rev-parse', 'HEAD']) !== notice.head) return null;
    await repository.status();
    const changed = new Set([
      ...(repository.state.workingTreeChanges || []),
      ...(repository.state.indexChanges || []),
    ].map(entry => path.resolve(entry.uri?.fsPath || '')));
    if (!notice.paths.every(file => changed.has(path.resolve(root, file)))) return null;
    return { ...notice, root };
  } finally {
    await io.unlink(destination).catch(() => {});
  }
}

async function gitDiff(cwd, args) {
  // No artificial hunk or file-count cutoff: the preview shows the actual unstaged patch.
  return (await execFileAsync('git', args, {
    cwd, timeout: 15000, maxBuffer: 64 * 1024 * 1024,
  })).stdout;
}

async function showNotice(vscode, repository, notice, readDiff = gitDiff, readConfig = git) {
  const patch = await readDiff(notice.root, [
    'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', ...notice.paths
  ]);
  if (!patch.trim()) return;

  if (notice.title && repository.inputBox && !repository.inputBox.value?.trim()) {
    let email = DEFAULT_EMAIL;
    try { email = await readConfig(notice.root, ['config', '--get', 'scm-toolkit.spellcheck-coauthor-email']) || DEFAULT_EMAIL; }
    catch { /* Use the default bot identity. */ }
    // Recheck after the asynchronous config read to preserve a newly typed draft.
    if (!repository.inputBox.value?.trim()) repository.inputBox.value = spellcheckMessage(notice.paths, email, notice.model, notice.title);
  }

  // This is a disposable read-only preview, not a modal Keep/Discard decision.
  // The Git working tree and any existing SCM commit draft remain untouched.
  const panel = vscode.window.createWebviewPanel(
    'sweetiebot.spellcheckDiff',
    notice.title || 'Spellcheck suggestions',
    vscode.ViewColumn.Beside,
    { enableScripts: false, retainContextWhenHidden: false }
  );
  panel.webview.html = renderSpellcheckDiff(patch, notice.title);
  panel.onDidChangeViewState(event => {
    // Dismiss by focusing another editor or Source Control, without changing edits.
    if (!event.webviewPanel.active) event.webviewPanel.dispose();
  });
}

async function registerPostCommitSpellcheckNotice(vscode, extensionContext, dependencies = {}) {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return;
  const gitExtension = await extension.activate();
  const api = gitExtension.getAPI(1);
  const pending = new Set();
  let disposed = false;
  async function scan() {
    if (disposed) return;
    for (const repository of api.repositories || []) {
      const root = repository.rootUri?.fsPath;
      if (!root || pending.has(root)) continue;
      pending.add(root);
      void takeNotice(repository, dependencies)
        .then(notice => notice && !disposed ? showNotice(vscode, repository, notice, dependencies.diff || gitDiff, dependencies.git || git) : undefined)
        .catch(error => console.warn('Sweetiebot spellcheck notification:', error.message))
        .finally(() => pending.delete(root));
    }
  }
  const interval = setInterval(scan, 2000);
  const opened = api.onDidOpenRepository?.(() => { void scan(); });
  extensionContext.subscriptions.push({
    dispose: () => {
      disposed = true;
      clearInterval(interval);
      opened?.dispose();
    }
  });
  void scan();
}

module.exports = {
  parseNotice, coauthor, spellcheckMessage, takeNotice, showNotice, gitDiff,
  registerPostCommitSpellcheckNotice,
};
