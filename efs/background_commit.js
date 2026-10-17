'use strict';

const { spawn, execFile } = require('node:child_process');
const { resolvePythonExecutable, pythonLaunchError } = require('./python_runtime');

function enqueue(script, cwd, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonExecutable(), [script, '--enqueue'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => {
      // Do not kill a child after it may have durably accepted the job.
      reject(new Error('Background commit acknowledgement timed out. Check the saved job before retrying.'));
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('error', error => { clearTimeout(timeout); reject(pythonLaunchError(error)); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr.trim() || 'Could not queue the background commit.'));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function registerBackgroundCommit(vscode, context) {
  const script = vscode.Uri.joinPath(context.extensionUri, 'background_commit.py').fsPath;
  let scanning = false;
  const seen = new Map();
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      const extension = vscode.extensions.getExtension('vscode.git');
      if (!extension) return;
      const git = await extension.activate();
      for (const repository of git.getAPI(1).repositories || []) {
        const root = repository.rootUri.fsPath;
        const status = await new Promise(resolve => {
          execFile(resolvePythonExecutable(), [script, '--status'], { cwd: root, timeout: 10000 },
            (error, stdout) => {
              try { resolve(error ? null : JSON.parse(stdout)); } catch { resolve(null); }
            });
        });
        if (!status) continue;
        const previous = seen.get(root);
        seen.set(root, status.id ? status : undefined);
        if (status.phase === 'blocked' && previous?.phase !== 'blocked') {
          void vscode.window.showErrorMessage('Background commit paused: ' + status.error);
        } else if (status.phase === 'pushing' && previous?.phase !== 'pushing') {
          void vscode.window.showInformationMessage('Background commit saved locally; push is pending and will retry automatically.');
        } else if (previous?.id && !status.id) {
          await repository.status();
          void vscode.window.showInformationMessage('Background commit completed.');
        }
      }
    } finally { scanning = false; }
  };
  const timer = setInterval(() => { void scan().catch(() => {}); }, 10000);
  context.subscriptions.push({ dispose() { clearInterval(timer); } });
  void scan().catch(() => {});
  context.subscriptions.push(vscode.commands.registerCommand('sweetiebot.queueCommit' , async (uri, options = {}) => {
    const root = vscode.Uri.from(uri?.rootUri ?? uri);
    if (root.scheme !== 'file') throw new Error('Background commits need a local repository.');
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The Git extension is unavailable.');
    const git = await extension.activate();
    const repository = git.getAPI(1).getRepository(root);
    if (!repository) throw new Error('The selected repository is unavailable.');
    await repository.status();
    if (repository.state.mergeChanges.length) throw new Error('Resolve conflicts before queuing a commit.');
    if (!repository.state.indexChanges.length) throw new Error('Stage the intended changes before queuing a commit.');
    let snapshot = '';
    if (options.codex && !String(options.message ?? '').trim()) {
      try {
        const codex = vscode.extensions.getExtension('openai.chatgpt');
        if (codex && !codex.isActive) await codex.activate();
        if ((await vscode.commands.getCommands(true)).includes('sweetiebot.readCodexContext')) {
          snapshot = await vscode.commands.executeCommand('sweetiebot.readCodexContext');
        }
      } catch { /* Chat context is optional; the staged tree remains authoritative. */ }
    }
    const configuration = vscode.workspace.getConfiguration('git', root);
    const result = await enqueue(script, root.fsPath, {
      message: options.message ?? '', context: typeof snapshot === 'string' ? snapshot.slice(-6000) : '',
      trailer: options.trailer ?? '', push: options.push ?? configuration.get('postCommitCommand') === 'push',
      sign: options.sign ?? configuration.get('enableCommitSigning') === true,
      signoff: options.signoff ?? configuration.get('alwaysSignOff') === true,
      remote: vscode.workspace.getConfiguration('scmToolkit', root).get('remote', 'origin')
    });
    void vscode.window.showInformationMessage('Commit queued in the background. You can close VS Code.');
    return result;
  }));
}

module.exports = { enqueue, registerBackgroundCommit };
