'use strict';

const vscode = require('vscode');
const { registerIndependentWorkspaceTrustCommand, promptForIndependentWorkspaceTrust } = require('./workspace_trust');
let trustedExtension;

async function activate(context) {
  registerIndependentWorkspaceTrustCommand(vscode, context);
  let startup;
  const startTrusted = () => {
    if (!vscode.workspace.isTrusted) return;
    if (!startup) {
      trustedExtension = require('./extension');
      startup = Promise.resolve().then(() => trustedExtension.activate(context));
    }
    return startup;
  };
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    void startTrusted().catch(error => console.error('Sweetiebot trusted startup:', error));
  }));
  // Do not load Git, indexing, or background services before trust is granted.
  await startTrusted();
  setImmediate(() => {
    void promptForIndependentWorkspaceTrust(vscode, context).catch(error =>
      console.warn('Sweetiebot independent workspace trust onboarding:', error.message));
  });
}

async function deactivate() {
  if (trustedExtension) await trustedExtension.deactivate();
}

module.exports = { activate, deactivate };
