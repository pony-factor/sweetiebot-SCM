'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const TRUST_SETUP_COMMAND = 'sweetiebot.configureIndependentWorkspaceTrust';
const TRUST_SETUP_SEEN_KEY = 'scmToolkit.independentWorkspaceTrustSetupSeen.v1';
const MANAGE_TRUST = 'Manage Workspace Trust';
let firstRunInFlight;

function independentWorkspaceParent() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Sweetiebot', 'Workspaces');
}

// VS Code deliberately owns the trust database. Extensions have no supported
// API for trusting an arbitrary folder on a user's behalf.
async function showIndependentWorkspaceTrustSetup(vscode, context, {
  manual = false, baseDirectory = independentWorkspaceParent(), io = fs
} = {}) {
  if (!manual) {
    const enabled = vscode.workspace.getConfiguration('scmToolkit')
      .get('promptForIndependentWorkspaceTrust', true);
    if (!enabled || context.globalState.get(TRUST_SETUP_SEEN_KEY, false)) return false;
    // Mark before displaying the dialog, so a second activating window does
    // not intentionally re-prompt after the first one has shown it.
    await context.globalState.update(TRUST_SETUP_SEEN_KEY, true);
  }

  const selection = await vscode.window.showInformationMessage(
    'Sweetiebot creates separate Git checkouts in ' + baseDirectory +
    '. To use extensions, terminals, and tasks without Restricted Mode, you can trust this parent folder in VS Code. Trusting it also trusts ALL future repositories under it.',
    {
      modal: true,
      detail: 'Only trust this parent if you accept that every repository copied into it inherits trust. ' +
        'Choose Manage Workspace Trust to copy the path and open VS Code\'s trust editor. ' +
        'Under Trusted Folders & Workspaces, add the copied path yourself. ' +
        'Sweetiebot will never grant or disable Workspace Trust automatically.'
    },
    MANAGE_TRUST,
    'Not Now'
  );
  if (selection !== MANAGE_TRUST) return false;

  // A real directory is easier for the user to recognize in the native editor.
  await io.mkdir(baseDirectory, { recursive: true });
  await vscode.env.clipboard.writeText(baseDirectory);
  await vscode.commands.executeCommand('workbench.trust.manage');
  return true;
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
  TRUST_SETUP_COMMAND, TRUST_SETUP_SEEN_KEY, independentWorkspaceParent,
  showIndependentWorkspaceTrustSetup, promptForIndependentWorkspaceTrust,
  registerIndependentWorkspaceTrustCommand
};
