'use strict';
const { spawn } = require('child_process');

function registerBranchMaintenance(vscode, context) {
  let running, disposed = false;
  const scan = async () => {
    if (disposed || running || !vscode.workspace.getConfiguration('scmToolkit').get('automaticBranchCleanup', true)) return;
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) return;
    const git = await extension.activate();
    if (disposed || running || !vscode.workspace.getConfiguration('scmToolkit').get('automaticBranchCleanup', true)) return;
    const repositories = git.getAPI(1).repositories.filter(repo => repo.rootUri.scheme === 'file');
    if (!repositories.length) return;
    const script = vscode.Uri.joinPath(context.extensionUri, 'prune_merged_branches.py').fsPath;
    const args = [script, '--force', ...repositories.flatMap(repo => ['--repo', repo.rootUri.fsPath])];
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3', args, { stdio: 'ignore' });
    running = child;
    const clear = () => { if (running === child) running = undefined; };
    child.once('error', clear);
    child.once('exit', clear);
  };
  const run = () => void scan().catch(() => {});
  const timer = setInterval(run, 10 * 60 * 1000);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); running?.kill(); } });
  run();
}

module.exports = { registerBranchMaintenance };
