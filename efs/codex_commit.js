'use strict';

const { spawn, execFile } = require('child_process');
const { resolvePythonExecutable, pythonLaunchError } = require('./python_runtime');
const { isCodex, withModel, collapse } = require('./codex_attribution');

function generateMessage(script, cwd, context) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonExecutable(), [script], {
      cwd, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    // Python enforces the configured timeout × attempts budget (up to 9000s).
    // Leave an extra minute for context collection and process shutdown.
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Local commit-message generation timed out. Ollama may be busy with OCR or another model.')); }, 9060000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('error', error => { clearTimeout(timeout); reject(pythonLaunchError(error)); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr.trim() || 'Local commit-message generation failed.'));
      try {
        const message = JSON.parse(stdout).message;
        if (typeof message !== 'string' || !message.trim()) throw new Error('Local Ollama returned an empty commit message.');
        resolve(message);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ context }));
  });
}

function normalizeStagedWhitespace(script, cwd) {
  return new Promise((resolve, reject) => {
    execFile(resolvePythonExecutable(), [script, '--normalize-staged-whitespace'],
      { cwd, timeout: 30000 }, (error, _stdout, stderr) => {
        if (error) return reject(new Error(stderr?.trim() || pythonLaunchError(error).message));
        resolve();
      });
  });
}


const path = require('node:path');
const activeCodexCommits = new Set();

// Keyboard commands have no repository argument. Never guess when multiple SCM
// repositories are open and none can be identified from the active editor.
async function resolveCommitRepository(vscode, uri) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) throw new Error('The VS Code Git extension is unavailable.');
  const git = await gitExtension.activate();
  const api = git.getAPI(1);
  if (uri) {
    const root = vscode.Uri.from(uri?.rootUri ?? uri);
    const repository = api.getRepository(root);
    if (!repository) throw new Error('The selected Git repository is unavailable.');
    return repository;
  }
  const repositories = api.repositories || [];
  if (!repositories.length) throw new Error('No Git repository is open.');
  if (repositories.length === 1) return repositories[0];
  const editorPath = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (editorPath) {
    const matching = repositories.filter(repository => {
      const rootPath = repository.rootUri.fsPath;
      const relative = path.relative(rootPath, editorPath);
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    }).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    if (matching.length) return matching[0];
  }
  const selections = repositories.map(repository => ({
    label: path.basename(repository.rootUri.fsPath),
    description: repository.rootUri.fsPath,
    repository
  }));
  const selection = await vscode.window.showQuickPick(selections, {
    title: 'Commit with Codex co-author',
    placeHolder: 'Choose the repository to commit'
  });
  return selection?.repository;
}

function readCommitGitSetting(rootPath, name, fallback) {
  return new Promise(resolve => {
    execFile('git', ['config', '--get', name], { cwd: rootPath, timeout: 5000 },
      (error, stdout) => resolve(error ? fallback : stdout.trim() || fallback));
  });
}

function coauthorTrailer(name, email) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100
      || /[\x00-\x1f\x7f<>\u2028\u2029]/.test(name)
      || typeof email !== 'string' || email.length > 254
      || !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) {
    throw new Error('Invalid co-author name or email in Sweetiebot settings.');
  }
  return 'Co-authored-by: ' + name + ' <' + email + '>';
}

function withCoauthorTrailer(message, trailer) {
  return collapse(message, trailer);
}

// Read only the active Codex window's displayed model and effort; never
// request conversation text solely for co-author attribution.
async function activeCodexModel(vscode) {
  try {
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if (!extension) return undefined;
    if (!extension.isActive) await extension.activate();
    if (!(await vscode.commands.getCommands(true)).includes('sweetiebot.readCodexModel')) return undefined;
    const model = await vscode.commands.executeCommand('sweetiebot.readCodexModel');
    return model && typeof model === 'object' ? model : undefined;
  } catch { return undefined; }
}

async function commitWithCodex(vscode, uri, options = {}) {
  const repository = await resolveCommitRepository(vscode, uri);
  if (!repository) return { cancelled: true };
  const root = repository.rootUri;
  const lockKey = root.toString();
  if (activeCodexCommits.has(lockKey)) throw new Error('A Codex co-author commit is already in progress.');
  activeCodexCommits.add(lockKey);
  try {
    const configuredName = options.trailer === undefined
      ? await readCommitGitSetting(root.fsPath, 'scm-toolkit.codex-coauthor-name', 'Codex')
      : null;
    const configuredEmail = options.trailer === undefined
      ? await readCommitGitSetting(root.fsPath, 'scm-toolkit.codex-coauthor-email', 'noreply@openai.com')
      : null;
    let trailer = options.trailer === undefined
      ? coauthorTrailer(configuredName, configuredEmail)
      : options.trailer;
    // Validate even caller-provided trailers; no arbitrary commit-message injection.
    if (typeof trailer !== 'string' || !/^Co-authored-by: [^\r\n<>]+ <[^\s<>@\r\n]+@[^\s<>@\r\n]+>$/.test(trailer)) {
      throw new Error('Invalid Codex co-author trailer.');
    }
    const parts = /^Co-authored-by: (.+?) <([^<>]+)>$/.exec(trailer);
    if (isCodex(parts[1], parts[2])) {
      const model = await activeCodexModel(vscode);
      trailer = coauthorTrailer(withModel(parts[1], model), parts[2]);
    }
    const input = repository.inputBox;
    const originalMessage = options.message === undefined ? (input?.value ?? '') : options.message;
    if (typeof originalMessage !== 'string') throw new Error('The commit message must be text.');
    const useCodexContext = options.codexCommitContext === undefined
      ? (await readCommitGitSetting(root.fsPath, 'scm-toolkit.codex-commit-context', 'false')) === 'true'
      : options.codexCommitContext === true;
    if (!originalMessage.trim() && !useCodexContext) {
      throw new Error('Enter a commit message before committing with Codex attribution.');
    }
    const push = vscode.workspace.getConfiguration('git', root).get('postCommitCommand') === 'push';
    if (vscode.workspace.getConfiguration('scmToolkit', root).get('durableBackgroundCommits', false) === true) {
      const preparedMessage = originalMessage.trim()
        ? withCoauthorTrailer(originalMessage, trailer) : '';
      // The background worker appends a missing trailer verbatim. Once the
      // message is consolidated, passing the old trailer would duplicate it.
      return await vscode.commands.executeCommand('sweetiebot.queueCommit', root, {
        message: preparedMessage, codex: true,
        trailer: preparedMessage ? '' : trailer, push
      });
    }
    let message = originalMessage;
    if (!message.trim()) {
      message = await vscode.commands.executeCommand('sweetiebot.generateCodexCommitMessage', root);
    }
    if (typeof message !== 'string' || !message.trim()) {
      throw new Error('Local commit generation did not return a message.');
    }
    const result = await vscode.commands.executeCommand(
      'sweetiebot.commitWithMessage', root, withCoauthorTrailer(message, trailer)
    );
    if (result?.queued || result?.cancelled) return result;
    if (input && input.value === originalMessage) input.value = '';
    return { committed: true, queued: false };
  } finally {
    activeCodexCommits.delete(lockKey);
  }
}

function registerCodexCommitCommand(vscode, extensionContext) {
  extensionContext.subscriptions.push(vscode.commands.registerCommand('sweetiebot.commitWithCodex', (uri, options) =>
    commitWithCodex(vscode, uri, options)
  ));
  extensionContext.subscriptions.push(vscode.commands.registerCommand('sweetiebot.commitWithMessage', async (uri, message) => {
    if (typeof message !== 'string' || !message.trim()) throw new Error('A commit message is required.');
    const root = vscode.Uri.from(uri?.rootUri ?? uri);
    // Manual attribution shares the queue while earlier titles are pending.
    // Keep the exact supplied message, including its co-author trailer.
    const queued = await vscode.commands.executeCommand('sweetiebot.queueCommit', root, {
      message, onlyIfPending: true
    });
    if (queued?.queued || queued?.cancelled) return queued;
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The VS Code Git extension is unavailable.');
    const git = await extension.activate();
    const repository = git.getAPI(1).getRepository(root);
    if (!repository) throw new Error('The selected Git repository is unavailable.');
    await repository.status();
    if (repository.state.mergeChanges.length) throw new Error('Resolve merge conflicts before committing.');
    if (!repository.state.indexChanges.length) throw new Error('There are no staged changes to commit.');
    const script = vscode.Uri.joinPath(extensionContext.extensionUri, 'local_codex_commit.py').fsPath;
    await normalizeStagedWhitespace(script, root.fsPath);
    const configuration = vscode.workspace.getConfiguration('git', root);
    // Pass the message directly to Git; never publish it to the SCM input.
    await repository.commit(message, {
      signCommit: configuration.get('enableCommitSigning') === true ? true : undefined,
      signoff: configuration.get('alwaysSignOff') === true
    });
    // The public Git API suppresses post-commit commands. Keep the Push
    // checkbox behavior by dispatching the normal push command afterward.
    if (configuration.get('postCommitCommand') === 'push') {
      await vscode.commands.executeCommand('git.push', root);
    }
    return { committed: true };
  }));
  extensionContext.subscriptions.push(vscode.commands.registerCommand('sweetiebot.prepareCodexCommit', async (uri, options = {}) => {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The VS Code Git extension is unavailable.');
    const git = await extension.activate();
    const repository = git.getAPI(1).getRepository(vscode.Uri.from(uri?.rootUri ?? uri));
    if (!repository) throw new Error('The selected Git repository is unavailable.');
    await repository.status();
    if (repository.state.mergeChanges.length) throw new Error('Resolve merge conflicts before committing.');
    const all = options.all === true || options.all === 'tracked';
    if (repository.state.indexChanges.length && !all) return;
    if (!repository.state.workingTreeChanges.length && !repository.state.untrackedChanges.length) {
      if (repository.state.indexChanges.length) return;
      throw new Error('There are no changes to commit.');
    }
    // The Git API makes paths relative to the root, which becomes an invalid
    // empty pathspec when the root itself is passed. Stage the changed files.
    const configuration = vscode.workspace.getConfiguration('git', repository.rootUri);
    const trackedOnly = options.all === 'tracked'
      || (!all && configuration.get('smartCommitChanges', 'all') === 'tracked');
    const paths = [...repository.state.workingTreeChanges, ...(trackedOnly ? [] : repository.state.untrackedChanges)]
      .filter(change => !trackedOnly || change.status !== 7 /* Git Status.UNTRACKED */)
      .map(change => change.uri.fsPath);
    if (paths.length) await repository.add([...new Set(paths)]);
    await repository.status();
    if (!repository.state.indexChanges.length) throw new Error('No changes were staged.');
  }));
  extensionContext.subscriptions.push(vscode.commands.registerCommand('sweetiebot.generateCodexCommitMessage', async uri => {
    const root = vscode.Uri.from(uri?.rootUri ?? uri);
    if (root.scheme !== 'file') throw new Error('Local commit generation requires a local repository.');
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Generating commit message', cancellable: false
    }, async () => {
      let context = '';
      try {
        const codex = vscode.extensions.getExtension('openai.chatgpt');
        if (codex && !codex.isActive) await codex.activate();
        if ((await vscode.commands.getCommands(true)).includes('sweetiebot.readCodexContext')) {
          const snapshot = await vscode.commands.executeCommand('sweetiebot.readCodexContext');
          if (typeof snapshot === 'string') context = snapshot;
        }
      } catch {
        // Conversation text is optional; generation can use the staged diff alone.
      }
      const script = vscode.Uri.joinPath(extensionContext.extensionUri, 'local_codex_commit.py').fsPath;
      return generateMessage(script, root.fsPath, context.slice(-6000));
    });
  }));
}

module.exports = { generateMessage, registerCodexCommitCommand };
