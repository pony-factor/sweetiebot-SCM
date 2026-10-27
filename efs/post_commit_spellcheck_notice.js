'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { renderSpellcheckDiff, spellcheckDiffFiles } = require('./spellcheck_diff');
const { resolvePythonExecutable, pythonLaunchError } = require('./python_runtime');

const execFileAsync = promisify(execFile);
const NOTICE_NAME = 'sweetiebot-spellcheck-ready.json';
const DEFAULT_EMAIL = '326443430+codex-pony[bot]@users.noreply.github.com';
const SPELLCHECK_LABEL = 'Spellcheck Changes';
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
    if (data.requestedAtMs !== undefined && (!Number.isSafeInteger(data.requestedAtMs) || data.requestedAtMs <= 0)) return null;
    if (data.tree !== undefined && !SHA.test(data.tree || '')) return null;
    if (data.branch !== undefined && (typeof data.branch !== 'string' || !data.branch || data.branch.length > 256 || /[\x00-\x20]/.test(data.branch))) return null;
    return { head: data.head, paths, ...(data.tree ? {tree: data.tree, branch: data.branch} : {}), ...(data.model ? { model: data.model.trim() } : {}), ...(data.title ? { title: data.title.trim() } : {}), ...(data.requestedAtMs ? {requestedAtMs: data.requestedAtMs} : {}) };
  } catch { return null; }
}

function coauthor(email = DEFAULT_EMAIL, model = '') {
  const name = model ? 'Spellchecker (Ollama ' + model + ')' : 'Spellchecker';
  if (typeof email !== 'string' || !NOREPLY_EMAIL.test(email.trim())) return '';
  if (typeof name !== 'string' || !name.trim() || /[\r\n<>]/.test(name)) return '';
  return 'Co-authored-by: ' + name.trim() + ' <' + email.trim() + '>';
}

function spellcheckMessage(paths, email = DEFAULT_EMAIL, model = '', title = '') {
  const count = paths.length;
  const subject = '🤖 ' + (title || SPELLCHECK_LABEL);
  const trailer = coauthor(email, model);
  return subject + (trailer ? '\n\n' + trailer : '');
}

async function generateReviewedCommitMessage(cwd, paths) {
  const bundled = path.join(__dirname, 'ai_commit.py');
  const script = await fs.access(bundled).then(() => bundled,
    () => path.join(__dirname, '../scripts/ai_commit.py'));
  // The normal generator controls its own retries and model selection.
  const {stdout} = await execFileAsync(resolvePythonExecutable(),
    [script, '--spellcheck-generate-message', JSON.stringify({paths})],
    {cwd, timeout: 9060000, maxBuffer: 1024 * 1024});
  const result = JSON.parse(stdout);
  if (typeof result.title !== 'string' || !result.title.trim()
      || /[\r\n\x00]/.test(result.title) || result.title.length > 72
      || typeof result.description !== 'string' || result.description.includes('\x00')) {
    throw new Error('Sweetiebot returned an invalid generated spellcheck commit message.');
  }
  return {title: result.title, description: result.description};
}

async function gitAction(cwd, args) {
  return (await execFileAsync('git', args, {cwd, timeout: 120000})).stdout;
}

async function git(cwd, args) {
  return (await execFileAsync('git', args, { cwd, timeout: 10000 })).stdout.trim();
}

// The SCM toolbar and Settings use exactly the same global Git preference.
// A Git config read with exit status 1 simply means the opt-in is unset.
async function postCommitSpellcheck(action = 'get', run = git) {
  const key = 'scm-toolkit.post-commit-spellcheck';
  let enabled;
  try {
    enabled = (await run(process.cwd(), ['config', '--global', '--bool', '--get', key])) === 'true';
  } catch (error) {
    if (error.code !== 1) throw error;
    enabled = false;
  }
  if (action === 'get') return enabled;
  if (action !== 'toggle') throw new Error('Invalid post-commit spellcheck action.');
  await run(process.cwd(), ['config', '--global', key, String(!enabled)]);
  return !enabled;
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
    if (!notice) return null;
    // A review belongs to the editor session that initiated the spellcheck.
    // A detached worker can finish after VS Code has quit, even after the
    // next launch. Legacy notices fall back to the on-disk write time.
    if (Number.isFinite(dependencies.sessionStartedAt)) {
      const originatedAt = notice.requestedAtMs ?? metadata.mtimeMs;
      if (!Number.isFinite(originatedAt) || originatedAt < dependencies.sessionStartedAt) return null;
    }
    const currentHead = await run(root, ['rev-parse', 'HEAD']);
    if (currentHead !== notice.head) {
      if (!notice.tree || !notice.branch || await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== notice.branch
          || await run(root, ['rev-parse', 'HEAD^{tree}']) !== notice.tree) return null;
      notice.head = currentHead;
    }
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
  session.changes = new Map();
  const files = spellcheckDiffFiles(patch);
  for (const file of files) {
    if (!session.paths.includes(file.name)) continue;
    for (const row of file.rows) {
      if (!['add', 'context'].includes(row.kind)) continue;
      const editId = randomUUID();
      session.edits.set(editId, { file: file.name, line: row.newNumber - 1, expected: row.text });
      row.editId = editId;
      for (const change of row.changes || []) {
        const changeId = randomUUID();
        session.changes.set(changeId, {editId, expected: row.text, ...change});
        change.changeId = changeId;
      }
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
    const current = await session.readDiff(session.root, [
      'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', ...session.paths
    ]);
    if (current !== session.patch) throw new Error('The files changed outside this preview. Reopen the diff before editing.');
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

// Undo precisely one correction using the original text and offsets supplied by
// the trusted server-side diff; never require users to retype/crop the old line.
async function undoSpellcheckChange(vscode, sessionId, changeId) {
  const session = previewSessions.get(sessionId);
  const change = session?.changes.get(changeId);
  if (!change) throw new Error('This spellcheck correction is no longer available.');
  const replacement = change.expected.slice(0, change.start) + change.before
    + change.expected.slice(change.end);
  return saveSpellcheckEdit(vscode, sessionId, change.editId, replacement);
}

async function normalizeReviewedWhitespace(root, paths) {
  const bundled = path.join(__dirname, 'local_codex_commit.py');
  const script = await fs.access(bundled).then(() => bundled,
    () => path.join(__dirname, '../scripts/local_codex_commit.py'));
  await new Promise((resolve, reject) => {
    const child = execFile(resolvePythonExecutable(), [script, '--normalize-reviewed-whitespace'],
      {cwd: root, timeout: 30000}, (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || pythonLaunchError(error).message));
        else resolve();
      });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(paths));
  });
}

async function verifyPreviewHead(session) {
  if (!session.head) return;
  const current = await session.readGit(session.root, ['rev-parse', 'HEAD']);
  if (current === session.head) return;
  if (!session.headTree || !session.branch
      || await session.readGit(session.root, ['symbolic-ref', '--quiet', 'HEAD']) !== session.branch
      || await session.readGit(session.root, ['rev-parse', 'HEAD^{tree}']) !== session.headTree) {
    throw new Error('The repository changed commits. Reopen the spelling preview.');
  }
  session.head = current;
}

async function finishSpellcheckPreview(vscode, sessionId, action, message, runAction = gitAction,
  normalize = normalizeReviewedWhitespace, generateTitle = generateReviewedCommitMessage) {
  const session = previewSessions.get(sessionId);
  if (!session || !['accept', 'revert'].includes(action)) throw new Error('This spellcheck preview is no longer available.');
  if (session.saving || session.acting) throw new Error('Wait for the current spelling edit to finish.');
  if (action === 'accept' && (typeof message !== 'string' || message.includes('\0'))) {
    throw new Error('The optional commit description is invalid.');
  }
  // The Source Control push checkbox controls Git's post-commit command.
  // Read it when Accept is clicked, not when the preview was first shown.
  const commitAndPush = action === 'accept'
    && vscode.workspace?.getConfiguration?.('git', vscode.Uri.file(session.root))
      ?.get('postCommitCommand', 'none') === 'push';
  session.acting = true;
  let queuedCommit = false;
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
    await verifyPreviewHead(session);
    if (session.branch && await session.readGit(session.root, ['symbolic-ref', '--quiet', 'HEAD']) !== session.branch) {
      throw new Error('The repository changed branches. Reopen the spelling preview.');
    }
    if (action === 'accept') {
      if (!current.trim()) throw new Error('There are no remaining spelling changes to commit.');
      const staged = await session.readDiff(session.root, [
        'diff', '--cached', '--no-ext-diff', '--no-color', '--', ...session.paths
      ]);
      if (staged.trim()) throw new Error('These files also have staged changes. Unstage them before accepting this preview.');
      let stagedByPreview;
      try {
        await normalize(session.root, session.paths);
        // Normalization can change the reviewed patch even when title generation
        // fails. Keep the next attempt aligned with the actual worktree.
        session.patch = await session.readDiff(session.root, [
          'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', ...session.paths
        ]);
        // Stage reviewed files BEFORE normal title generation. --only later
        // restricts the commit to these files, preserving unrelated staged work.
        await runAction(session.root, ['--literal-pathspecs', 'add', '--', ...session.paths]);
        stagedByPreview = await session.readDiff(session.root, [
          'diff', '--cached', '--no-ext-diff', '--no-color', '--', ...session.paths
        ]);
        if ((await vscode.commands?.getCommands?.(true) || []).includes('sweetiebot.queueCommit')) {
          const result = await vscode.commands.executeCommand('sweetiebot.queueCommit', vscode.Uri.file(session.root), {
            paths: session.paths, message: '', description: message.trim(), trailer: session.trailer,
            push: commitAndPush, skipSpellcheck: true
          });
          if (result?.queued !== true) throw new Error('The reviewed spellcheck commit was not queued.');
          queuedCommit = true;
        } else {
          const generated = await generateTitle(session.root, session.paths);
          if (!generated || typeof generated.title !== 'string' || !generated.title.trim()) {
            throw new Error('The normal commit-title generator did not return a title.');
          }
          if (session.head && await session.readGit(session.root, ['rev-parse', 'HEAD']) !== session.head) {
            throw new Error('The repository advanced while generating the title. Reopen the spelling preview.');
          }
          if (session.branch && await session.readGit(session.root, ['symbolic-ref', '--quiet', 'HEAD']) !== session.branch) {
            throw new Error('The active branch changed while generating the title. Reopen the spelling preview.');
          }
          const args = ['--literal-pathspecs', 'commit', '--only', '--cleanup=verbatim',
            '--message', generated.title];
          const body = [generated.description, message.trim()].filter(Boolean).join('\n\n');
          if (body) args.push('--message', body);
          // Append attribution AFTER the usual subject and explanatory body.
          if (session.trailer) args.push('--message', session.trailer);
          args.push('--', ...session.paths);
          await runAction(session.root, args);
        }
      } catch (error) {
        // Only undo our staging while the branch, commit, and selected index
        // entries still match. Never discard concurrent work or rewrite files.
        if (stagedByPreview?.trim()) {
          try {
            if (session.head && await session.readGit(session.root, ['rev-parse', 'HEAD']) !== session.head) throw new Error('The repository advanced.');
            if (session.branch && await session.readGit(session.root, ['symbolic-ref', '--quiet', 'HEAD']) !== session.branch) throw new Error('The branch changed.');
            const stagedNow = await session.readDiff(session.root, [
              'diff', '--cached', '--no-ext-diff', '--no-color', '--', ...session.paths
            ]);
            if (stagedNow !== stagedByPreview) throw new Error('The staged files changed.');
            await runAction(session.root, ['--literal-pathspecs', 'restore', '--staged', '--', ...session.paths]);
          } catch (cleanupError) {
            throw new Error((error.message || error) + ' Reviewed files could not be unstaged safely: ' + (cleanupError.message || cleanupError));
          }
        }
        throw error;
      }
    } else {
      // The preview compares with the index, so revert to that same baseline.
      await runAction(session.root, ['--literal-pathspecs', 'restore', '--worktree', '--', ...session.paths]);
    }
    closeSpellcheckPopup(sessionId);
    // A refresh failure must not turn a completed commit/revert into a retry.
    try { await session.repository.status?.(); } catch { /* Refresh next polling cycle. */ }
    if (queuedCommit) return {action, queued: true};
    if (!commitAndPush) return {action};
    try {
      if (!session.branch) {
        throw new Error('No active branch or Git push operation is available.');
      }
      if (await session.readGit(session.root, ['symbolic-ref', '--quiet', 'HEAD']) !== session.branch) {
        throw new Error('The active branch changed before the spelling commit could be pushed.');
      }
      // Dispatch the same command as the SCM Push action, including upstream
      // publication and Sweetiebot's workbench push/rejection recovery.
      await vscode.commands.executeCommand('git.push', vscode.Uri.file(session.root));
      return {action, pushed: true};
    } catch (error) {
      // The commit has already succeeded. Close the one-shot preview and report
      // a push failure without suggesting that Accept can safely be retried.
      vscode.window?.showErrorMessage?.(
        'Spellcheck changes were committed locally, but could not be pushed: ' + (error?.message || error)
      );
      return {action, pushed: false};
    }
  } finally { session.acting = false; }
}

function closeSpellcheckPopup(sessionId, draftMessage) {
  const session = previewSessions.get(sessionId);
  const inputBox = session?.repository?.inputBox;
  // Dismissing the review leaves corrections unstaged; keep the reviewed
  // message ready for a normal commit, without overwriting another draft.
  if (typeof draftMessage === 'string' && draftMessage.trim()
      && typeof inputBox?.value === 'string' && !inputBox.value.trim()) {
    inputBox.value = draftMessage;
  }
  previewSessions.delete(sessionId);
}

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
  let headTree = notice.tree;
  if (!headTree && notice.head) {
    try { const tree = await readConfig(notice.root, ['rev-parse', notice.head + '^{tree}']); if (SHA.test(tree)) headTree = tree; } catch { /* Old previews retain strict commit identity. */ }
  }
  const session = {
    id: randomUUID(), root: notice.root, paths: notice.paths, head: notice.head, headTree, branch,
    title: SPELLCHECK_LABEL, readDiff, readGit: readConfig, repository,
    message: '', trailer: coauthor(email, notice.model)
  };
  previewSessions.set(session.id, session);
  previews.push(editablePreview(session, patch));

}

async function registerPostCommitSpellcheckNotice(vscode, extensionContext, dependencies = {}) {
  // Capture before Git activation: anything initiated in a prior session is
  // never offered for review when this window is reopened or reloaded.
  const sessionStartedAt = Date.now();
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand('sweetiebot.postCommitSpellcheck', action =>
      postCommitSpellcheck(action)),
    vscode.commands.registerCommand('sweetiebot.takeSpellcheckPopup', takeSpellcheckPopup)
  );
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand('sweetiebot.saveSpellcheckEdit', (sessionId, editId, text) =>
      saveSpellcheckEdit(vscode, sessionId, editId, text)),
    vscode.commands.registerCommand('sweetiebot.undoSpellcheckChange', (sessionId, changeId) =>
      undoSpellcheckChange(vscode, sessionId, changeId)),
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
      void takeNotice(repository, {...dependencies, sessionStartedAt})
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
  normalizeReviewedWhitespace, finishSpellcheckPreview, saveSpellcheckEdit, undoSpellcheckChange, closeSpellcheckPopup, takeSpellcheckPopup, parseNotice, coauthor, spellcheckMessage, takeNotice, showNotice, gitDiff,
  registerPostCommitSpellcheckNotice, postCommitSpellcheck,
};
