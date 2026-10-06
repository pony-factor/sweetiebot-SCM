'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Restore the running local app and the Codex version VS Code actually selects.
function registerCodexRefresh(vscode, context) {
  if (process.platform !== 'darwin' || vscode.env.remoteName) return;
  const output = vscode.window.createOutputChannel('Sweetie Bot app repair');
  let child, timer, disposed = false, pending = false, reloadOffered = false;
  const enabled = () => vscode.workspace.getConfiguration('scmToolkit').get('automaticAppRepair', true);
  const refresh = () => {
    if (disposed || !enabled()) return;
    if (child) { pending = true; return; }
    const codex = vscode.extensions.getExtension('openai.chatgpt');
    const script = vscode.Uri.joinPath(context.extensionUri,
      'codex-customizations', 'scripts', 'repair.py').fsPath;
    const args = [script, '--app', path.resolve(vscode.env.appRoot, '../../..')];
    if (codex) args.push('--codex-extension', codex.extensionPath);
    child = spawn('python3', args, {
      cwd: context.extensionPath,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const running = child;
    let finished = false, stdout = '', timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      output.appendLine('Automatic repair timed out; it will retry later.');
      running.kill();
    }, 90000);
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child = undefined;
      if (!disposed && !timedOut && code === 0 && /^Installed SCM toolkit /m.test(stdout) && !reloadOffered) {
        reloadOffered = true;
        void vscode.window.showInformationMessage(
          'Sweetie Bot updated or restored your app customizations. Reload this window to apply them.',
          'Reload Window'
        ).then(choice => {
          if (!disposed && choice === 'Reload Window') return vscode.commands.executeCommand('workbench.action.reloadWindow');
        }).catch(error => output.appendLine(error.message));
      } else if (!disposed && code !== 0) {
        output.appendLine('Repair did not complete. Check the error above; macOS App Management permission or support for this app version may be required.');
      }
      if (pending && !disposed) { pending = false; schedule(); }
    };
    running.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-65536); output.append(data.toString()); });
    running.stderr.on('data', data => output.append(data.toString()));
    running.on('error', error => { output.appendLine(error.message); finish(-1); });
    running.on('close', finish);
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(refresh, 2000);
  };
  // Periodic checks also catch updates missed while this extension was inactive.
  const interval = setInterval(schedule, 60 * 60 * 1000);
  context.subscriptions.push(output, vscode.extensions.onDidChange(schedule),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('scmToolkit.automaticAppRepair')) schedule();
    }), {
      dispose() { disposed = true; clearInterval(interval); clearTimeout(timer); child?.kill(); }
    });
  schedule();
}

module.exports = { registerCodexRefresh };
