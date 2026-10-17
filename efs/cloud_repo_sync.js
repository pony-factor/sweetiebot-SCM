'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { resolvePythonExecutable } = require('./python_runtime');

function registerCloudRepoSync(vscode, context) {
  const output = vscode.window.createOutputChannel('Sweetiebot Cloud Repo Sync');
  context.subscriptions.push(output);
  let previous;
  const configure = () => {
    const enabled = vscode.workspace.getConfiguration('scmToolkit').get('cloudRepositorySync', false) === true;
    if (enabled === previous) return;
    previous = enabled;
    const wrapper = process.env.SCM_TOOLKIT_AI_WRAPPER_PATH
      || path.join(os.homedir(), '.local', 'bin', 'scm-toolkit-git');
    const script = path.join(path.dirname(wrapper), 'cloud_repo_sync.py');
    const child = spawn(resolvePythonExecutable(), [script, enabled ? '--install' : '--uninstall'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += String(data).slice(0, 1000); });
    child.on('error', error => output.appendLine('Configuration failed: ' + error.message));
    child.on('close', code => output.appendLine(code
      ? 'Cloud sync setup failed: ' + errors.trim()
      : 'Cloud repository mirror ' + (enabled ? 'enabled (every 8 hours)' : 'disabled')));
  };
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('scmToolkit.cloudRepositorySync')) configure();
  }));
  configure();
}
module.exports = { registerCloudRepoSync };
