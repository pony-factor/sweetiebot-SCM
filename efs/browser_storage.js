'use strict';

// Local VS Code workspaces default to global Integrated Browser storage,
// exposing one repo's unsent ChatGPT draft to other repository windows.
// Prefer persistent workspace sessions without deleting any cached data.
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
