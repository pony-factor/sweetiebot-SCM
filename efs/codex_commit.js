'use strict';

const { spawn } = require('child_process');
const { resolvePythonExecutable, pythonLaunchError } = require('./python_runtime');

function generateMessage(script, cwd, context) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonExecutable(), [script], {
      cwd, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    // Allow both 300-second Ollama attempts, including time queued behind OCR.
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Local commit-message generation timed out. Ollama may be busy with OCR or another model. Let that work finish, then try again.')); }, 630000);
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

function registerCodexCommitCommand(vscode, extensionContext) {
  extensionContext.subscriptions.push(vscode.commands.registerCommand('sweetiebot.commitWithMessage', async (uri, message) => {
    if (typeof message !== 'string' || !message.trim()) throw new Error('A commit message is required.');
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The VS Code Git extension is unavailable.');
    const git = await extension.activate();
    const root = vscode.Uri.from(uri?.rootUri ?? uri);
    const repository = git.getAPI(1).getRepository(root);
    if (!repository) throw new Error('The selected Git repository is unavailable.');
    await repository.status();
    if (repository.state.mergeChanges.length) throw new Error('Resolve merge conflicts before committing.');
    if (!repository.state.indexChanges.length) throw new Error('There are no staged changes to commit.');
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
  }));
  extensionContext.subscriptions.push(vscode.commands.registerCommand('sweetiebot.prepareCodexCommit', async uri => {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The VS Code Git extension is unavailable.');
    const git = await extension.activate();
    const repository = git.getAPI(1).getRepository(vscode.Uri.from(uri?.rootUri ?? uri));
    if (!repository) throw new Error('The selected Git repository is unavailable.');
    await repository.status();
    if (repository.state.mergeChanges.length) throw new Error('Resolve merge conflicts before committing.');
    if (repository.state.indexChanges.length) return;
    if (!repository.state.workingTreeChanges.length && !repository.state.untrackedChanges.length) {
      throw new Error('There are no changes to commit.');
    }
    // The Git API makes paths relative to the root, which becomes an invalid
    // empty pathspec when the root itself is passed. Stage the changed files.
    const paths = [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges]
      .map(change => change.uri.fsPath);
    await repository.add([...new Set(paths)]);
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
