'use strict';

const { spawn } = require('child_process');

// Reapply to the extension VS Code actually selects, rather than a version name.
function registerCodexRefresh(vscode, context) {
  if (process.platform !== 'darwin') return;
  const output = vscode.window.createOutputChannel('Sweetiebot Codex customizations');
  let child, timer, disposed = false, pending = false;
  const refresh = () => {
    if (disposed) return;
    if (child) { pending = true; return; }
    const codex = vscode.extensions.getExtension('openai.chatgpt');
    if (!codex) return;
    const script = vscode.Uri.joinPath(context.extensionUri,
      'codex-customizations', 'scripts', 'install.py').fsPath;
    child = spawn('python3', [script, '--codex-only', '--codex-extension', codex.extensionPath],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const running = child;
    let finished = false;
    const timeout = setTimeout(() => running.kill(), 90000);
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child = undefined;
      if (pending && !disposed) { pending = false; schedule(); }
    };
    running.stdout.on('data', data => output.append(data.toString()));
    running.stderr.on('data', data => output.append(data.toString()));
    running.on('error', error => { output.appendLine(error.message); finish(); });
    running.on('close', finish);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 2000);
  };
  context.subscriptions.push(output, vscode.extensions.onDidChange(schedule), {
    dispose() { disposed = true; clearTimeout(timer); child?.kill(); }
  });
  schedule();
}

module.exports = { registerCodexRefresh };
