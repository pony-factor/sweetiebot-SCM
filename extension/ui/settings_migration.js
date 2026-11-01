'use strict';

// Retain explicitly saved VS Code preferences when the public namespace changes.
// Leave old values intact so older installs and user-specific settings are not erased.
const properties = require('../package.json').contributes.configuration.properties;

async function migrateLegacySettings(vscode) {
  if (!vscode.workspace?.getConfiguration || !vscode.ConfigurationTarget) return;
  const { Global, Workspace, WorkspaceFolder } = vscode.ConfigurationTarget;
  const scopes = [
    { target: Global, field: 'globalValue' },
    { target: Workspace, field: 'workspaceValue' }
  ];
  const folders = vscode.workspace.workspaceFolders || [];

  for (const [fullKey, definition] of Object.entries(properties)) {
    if (!fullKey.startsWith('sweetiebot.')) continue;
    const key = fullKey.slice('sweetiebot.'.length);
    const targets = [...scopes];
    if (definition.scope === 'resource' || definition.scope === 'language-overridable') {
      for (const folder of folders) {
        targets.push({ target: WorkspaceFolder, field: 'workspaceFolderValue', uri: folder.uri });
      }
    }
    for (const { target, field, uri } of targets) {
      try {
        const legacy = vscode.workspace.getConfiguration('scmToolkit', uri).inspect(key);
        if (legacy?.[field] === undefined) continue;
        const canonical = vscode.workspace.getConfiguration('sweetiebot', uri);
        if (canonical.inspect(key)?.[field] !== undefined) continue;
        await canonical.update(key, legacy[field], target);
      } catch (error) {
        console.warn('Sweetiebot setting migration skipped:', fullKey, field, error.message);
      }
    }
  }
}

module.exports = { migrateLegacySettings };
