'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { resolvePythonExecutable } = require('./python_runtime');

function registerCloudRepoSync(vscode, context) {
  const output = vscode.window.createOutputChannel('Sweetiebot Cloud Repo Sync');
  context.subscriptions.push(output);
  let previous;
  const configure = (force = false) => {
    const enabled = vscode.workspace.getConfiguration('scmToolkit').get('cloudRepositorySync', false) === true;
    if (!force && enabled === previous) return;
    previous = enabled;
    const wrapper = process.env.SCM_TOOLKIT_AI_WRAPPER_PATH
      || path.join(os.homedir(), '.local', 'bin', 'scm-toolkit-git');
    const script = path.join(path.dirname(wrapper), 'cloud_repo_sync.py');
    const folders = (vscode.workspace.workspaceFolders || [])
      .filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    const child = spawn(resolvePythonExecutable(), [script, enabled ? '--install' : '--uninstall',
      '--register', ...folders],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += String(data).slice(0, 1000); });
    child.on('error', error => output.appendLine('Configuration failed: ' + error.message));
    child.on('close', code => output.appendLine(code
      ? 'Cloud sync setup failed: ' + errors.trim()
      : 'Local repository sync ' + (enabled ? 'enabled (every 15 minutes; active in the past week)' : 'disabled')));
  };
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('scmToolkit.cloudRepositorySync')) configure();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => configure(true)));
  configure();
}
module.exports = { registerCloudRepoSync };
