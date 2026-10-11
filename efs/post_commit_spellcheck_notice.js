'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

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
    return { head: data.head, paths, ...(data.model ? { model: data.model.trim() } : {}) };
  } catch { return null; }
}

function coauthor(email = DEFAULT_EMAIL, model = '') {
  const name = model ? 'Ollama (' + model + ')' : 'Ollama';
  if (typeof email !== 'string' || !NOREPLY_EMAIL.test(email.trim())) return '';
  if (typeof name !== 'string' || !name.trim() || /[\r\n<>]/.test(name)) return '';
  return 'Co-authored-by: ' + name.trim() + ' <' + email.trim() + '>';
}

function spellcheckMessage(paths, email = DEFAULT_EMAIL, model = '') {
  const count = paths.length;
  const subject = '🤖 Spellcheck ' + count + ' Markdown file' + (count === 1 ? '' : 's');
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

async function showNotice(vscode, repository, notice, readConfig = git) {
  let email = DEFAULT_EMAIL;
  try { email = await readConfig(notice.root, ['config', '--get', 'scm-toolkit.spellcheck-coauthor-email']) || DEFAULT_EMAIL; }
  catch { /* Use the supplied bot identity by default. */ }

  const message = spellcheckMessage(notice.paths, email, notice.model);
  const input = repository.inputBox;
  const existing = input?.value?.trim();
  if (!existing && input) input.value = message;

  const attribution = coauthor(email, notice.model)
    ? ''
    : ' Configure scm-toolkit.spellcheck-coauthor-email with the bot account’s actual GitHub noreply address for linked attribution.';
  const detail = notice.paths.length + ' Markdown file'
    + (notice.paths.length === 1 ? ' has' : 's have')
    + ' spellcheck edits ready for review.';
  const action = existing ? 'Use spellcheck message' : 'Review changes';
  const selection = await vscode.window.showInformationMessage(
    'Sweetiebot: ' + detail
      + (existing ? ' Existing commit draft kept.' : ' Commit message prepared.')
      + attribution,
    action
  );
  if (selection === 'Use spellcheck message' && input) input.value = message;
  if (selection === 'Review changes') await vscode.commands.executeCommand('workbench.view.scm');
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
        .then(notice => notice && !disposed ? showNotice(vscode, repository, notice, dependencies.git || git) : undefined)
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
  parseNotice, coauthor, spellcheckMessage, takeNotice, showNotice,
  registerPostCommitSpellcheckNotice,
};
