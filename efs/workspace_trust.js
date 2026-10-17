'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const TRUST_SETUP_COMMAND = 'sweetiebot.configureIndependentWorkspaceTrust';
const TRUST_SETUP_SEEN_KEY = 'scmToolkit.independentWorkspaceTrustSetupSeen.v3';
const REQUEST_PARENT_TRUST_COMMAND = 'sweetiebot.requestIndependentWorkspaceTrust';
let firstRunInFlight;

function independentWorkspaceParent() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Sweetiebot', 'Workspaces');
}

// The workbench opens VS Code's native resource-trust dialog for the fixed
// Sweetiebot parent. VS Code owns both approval and its trust database.
async function showIndependentWorkspaceTrustSetup(vscode, context, {
  manual = false, baseDirectory = independentWorkspaceParent(), io = fs
} = {}) {
  if (!manual) {
    const enabled = vscode.workspace.getConfiguration('scmToolkit')
      .get('promptForIndependentWorkspaceTrust', true);
    const untrustedClone = vscode.workspace.isTrusted === false &&
      (vscode.workspace.workspaceFolders || []).some(({ uri }) => {
        if (uri.scheme !== 'file') return false;
        const relative = path.relative(baseDirectory, uri.fsPath);
        return relative !== '' && relative !== '..' &&
          !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      });
    // A dismissed first-run guide must not suppress help in a new restricted
    // clone. Remember that clone's dismissal separately to avoid reload nagging.
    const state = untrustedClone ? context.workspaceState : context.globalState;
    if (!enabled || state.get(TRUST_SETUP_SEEN_KEY, false)) return false;
    // Mark before displaying the dialog, so a second activating window does
    // not intentionally re-prompt after the first one has shown it.
    await state.update(TRUST_SETUP_SEEN_KEY, true);
  }

  await io.mkdir(baseDirectory, { recursive: true });
  return (await vscode.commands.executeCommand(REQUEST_PARENT_TRUST_COMMAND)) === true;
}

function promptForIndependentWorkspaceTrust(vscode, context) {
  if (!firstRunInFlight) {
    firstRunInFlight = showIndependentWorkspaceTrustSetup(vscode, context)
      .finally(() => { firstRunInFlight = undefined; });
  }
  return firstRunInFlight;
}

function registerIndependentWorkspaceTrustCommand(vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand(TRUST_SETUP_COMMAND, () =>
    showIndependentWorkspaceTrustSetup(vscode, context, { manual: true })));
}

module.exports = {
  TRUST_SETUP_COMMAND, TRUST_SETUP_SEEN_KEY, REQUEST_PARENT_TRUST_COMMAND, independentWorkspaceParent,
  showIndependentWorkspaceTrustSetup, promptForIndependentWorkspaceTrust,
  registerIndependentWorkspaceTrustCommand
};
