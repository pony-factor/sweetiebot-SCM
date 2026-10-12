'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { renderSpellcheckDiff, spellcheckDiffFiles } = require('./spellcheck_diff');

const execFileAsync = promisify(execFile);
const NOTICE_NAME = 'sweetiebot-spellcheck-ready.json';
const DEFAULT_EMAIL = '326443430+codex-pony[bot]@users.noreply.github.com';
const NOREPLY_EMAIL = /^(?:[1-9]\d*\+)?[a-z\d-]+(?:\[bot\])?@users\.noreply\.github\.com$/i;
const previews = [];
const previewSessions = new Map();
function takeSpellcheckPopup() { return previews.shift(); }

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

async function gitAction(cwd, args) {
  return (await execFileAsync('git', args, {cwd, timeout: 120000})).stdout;
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

function editablePreview(session, patch) {
  session.patch = patch;
  session.edits = new Map();
  const files = spellcheckDiffFiles(patch);
  for (const file of files) {
    if (!session.paths.includes(file.name)) continue;
    for (const row of file.rows) {
      if (!['add', 'context'].includes(row.kind)) continue;
      const editId = randomUUID();
      session.edits.set(editId, { file: file.name, line: row.newNumber - 1, expected: row.text });
      row.editId = editId;
    }
  }
  return { sessionId: session.id, title: session.title, message: session.message, html: renderSpellcheckDiff(patch, session.title), files };
}

async function saveSpellcheckEdit(vscode, sessionId, editId, text) {
  const session = previewSessions.get(sessionId);
  const edit = session?.edits.get(editId);
  if (!edit || typeof text !== 'string' || text.length > 1024 * 1024 || text.includes('\0')) {
    throw new Error('This spellcheck preview is no longer available.');
  }
  if (session.saving || session.acting) throw new Error('Wait for the current spelling edit to finish saving.');
  session.saving = true;
  try {
    const target = path.resolve(session.root, edit.file);
    const root = await fs.realpath(session.root);
    const actual = await fs.realpath(target);
    const relative = path.relative(root, actual);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('The preview file is outside this repository.');
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    if (document.isDirty) throw new Error('Save the existing editor changes before editing this preview.');
    if (edit.line >= document.lineCount || document.lineAt(edit.line).text !== edit.expected) {
      throw new Error('This line changed since the preview opened. Reopen its diff before editing it.');
    }
    const replacement = text.replace(/\r\n|\r/g, '\n').replace(/\n/g, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, document.lineAt(edit.line).range, replacement);
    if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error('Could not apply the spelling edit.');
    if (!await document.save()) throw new Error('The spelling edit remains unsaved in the editor.');
    const patch = await session.readDiff(session.root, [
      'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', ...session.paths
    ]);
    return editablePreview(session, patch);
  } finally { session.saving = false; }
}

async function finishSpellcheckPreview(vscode, sessionId, action, message, runAction = gitAction) {
  const session = previewSessions.get(sessionId);
  if (!session || !['accept', 'revert'].includes(action)) throw new Error('This spellcheck preview is no longer available.');
  if (session.saving || session.acting) throw new Error('Wait for the current spelling edit to finish.');
  if (action === 'accept' && (typeof message !== 'string' || !message.trim() || message.includes('\0'))) {
    throw new Error('Enter a commit message before accepting the spelling changes.');
  }
  session.acting = true;
  try {
    for (const file of session.paths) {
      const uri = vscode.Uri.file(path.resolve(session.root, file));
      if (vscode.workspace.textDocuments.some(document => document.uri.fsPath === uri.fsPath && document.isDirty)) {
        throw new Error('Save the existing editor changes before accepting or reverting this preview.');
      }
    }
    const current = await session.readDiff(session.root, [
      'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', ...session.paths
    ]);
    if (current !== session.patch) throw new Error('The files changed outside this preview. Reopen the diff before accepting or reverting.');
    if (session.head && await session.readGit(session.root, ['rev-parse', 'HEAD']) !== session.head) {
      throw new Error('The repository changed commits. Reopen the spelling preview.');
    }
    if (session.branch && await session.readGit(session.root, ['symbolic-ref', '--quiet', 'HEAD']) !== session.branch) {
      throw new Error('The repository changed branches. Reopen the spelling preview.');
    }
    if (action === 'accept') {
      if (!current.trim()) throw new Error('There are no remaining spelling changes to commit.');
      const staged = await session.readDiff(session.root, [
        'diff', '--cached', '--no-ext-diff', '--no-color', '--', ...session.paths
      ]);
      if (staged.trim()) throw new Error('These files also have staged changes. Unstage them before accepting this preview.');
      // --only includes the reviewed working files while preserving other staged work.
      await runAction(session.root, ['--literal-pathspecs', 'commit', '--only', '--cleanup=verbatim', '--message', message, '--', ...session.paths]);
    } else {
      // The preview compares with the index, so revert to that same baseline.
      await runAction(session.root, ['--literal-pathspecs', 'restore', '--worktree', '--', ...session.paths]);
    }
    closeSpellcheckPopup(sessionId);
    // A refresh failure must not turn a completed commit/revert into a retry.
    try { await session.repository.status?.(); } catch { /* Refresh next polling cycle. */ }
    return {action};
  } finally { session.acting = false; }
}

function closeSpellcheckPopup(sessionId) { previewSessions.delete(sessionId); }

async function showNotice(vscode, repository, notice, readDiff = gitDiff, readConfig = git) {
  const patch = await readDiff(notice.root, [
    'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', ...notice.paths
  ]);
  if (!patch.trim()) return;

  let email = DEFAULT_EMAIL;
  try { email = await readConfig(notice.root, ['config', '--get', 'scm-toolkit.spellcheck-coauthor-email']) || DEFAULT_EMAIL; }
  catch { /* Use the default bot identity. */ }
  let branch;
  try { branch = await readConfig(notice.root, ['symbolic-ref', '--quiet', 'HEAD']); }
  catch { /* Detached HEAD has no branch name. */ }
  const session = {
    id: randomUUID(), root: notice.root, paths: notice.paths, head: notice.head, branch,
    title: notice.title || 'Spellchecks Performed', readDiff, readGit: readConfig, repository,
    message: spellcheckMessage(notice.paths, email, notice.model, notice.title)
  };
  previewSessions.set(session.id, session);
  previews.push(editablePreview(session, patch));

}

async function registerPostCommitSpellcheckNotice(vscode, extensionContext, dependencies = {}) {
  extensionContext.subscriptions.push(vscode.commands.registerCommand(
    'sweetiebot.takeSpellcheckPopup', takeSpellcheckPopup
  ));
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand('sweetiebot.saveSpellcheckEdit', (sessionId, editId, text) =>
      saveSpellcheckEdit(vscode, sessionId, editId, text)),
    vscode.commands.registerCommand('sweetiebot.closeSpellcheckPopup', closeSpellcheckPopup),
    vscode.commands.registerCommand('sweetiebot.finishSpellcheckPreview', (sessionId, action, message) =>
      finishSpellcheckPreview(vscode, sessionId, action, message)),
    {dispose() { previews.length = 0; previewSessions.clear(); }}
  );
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
  finishSpellcheckPreview, saveSpellcheckEdit, closeSpellcheckPopup, takeSpellcheckPopup, parseNotice, coauthor, spellcheckMessage, takeNotice, showNotice, gitDiff,
  registerPostCommitSpellcheckNotice,
};
