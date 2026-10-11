'use strict';
const { spawn } = require('child_process');
const { resolvePythonExecutable } = require('./python_runtime');

function registerBranchMaintenance(vscode, context) {
  let running, disposed = false;
  const output = vscode.window.createOutputChannel('Sweetiebot Branch Cleanup');
  context.subscriptions.push(output);
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
    const child = spawn(resolvePythonExecutable(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    running = child;
    child.stdout.on('data', chunk => output.append(String(chunk)));
    child.stderr.on('data', chunk => output.append(String(chunk)));
    const clear = () => { if (running === child) running = undefined; };
    child.once('error', error => { output.appendLine(`Branch cleanup failed: ${error.message}`); clear(); });
    child.once('exit', code => {
      if (code) output.appendLine(`Branch cleanup exited with status ${code}.`);
      clear();
      if (!disposed) {
        for (const repo of repositories) void repo.status().catch(() => {});
      }
    });
  };
  const run = () => void scan().catch(() => {});
  const timer = setInterval(run, 10 * 60 * 1000);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); running?.kill(); } });
  run();
}

module.exports = { registerBranchMaintenance };
