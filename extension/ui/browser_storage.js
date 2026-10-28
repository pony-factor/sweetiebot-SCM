'use strict';

// Use persistent browser sessions. The native patch routes both workspace
// and global sessions to Sweetiebot's shared profile across repositories.
async function configureWorkspaceBrowserStorage(vscode) {
  const config = vscode.workspace.getConfiguration('workbench.browser');
  const selection = config.inspect?.('dataStorage');
  // Explicit user/workspace choices and unsupported builds are untouched.
  if (!selection || selection.globalValue !== undefined ||
      selection.workspaceValue !== undefined ||
      selection.workspaceFolderValue !== undefined ||
      config.get('dataStorage', 'default') !== 'default') return false;
  await config.update('dataStorage', 'workspace', vscode.ConfigurationTarget.Global);
  return true;
}

module.exports = { configureWorkspaceBrowserStorage };
