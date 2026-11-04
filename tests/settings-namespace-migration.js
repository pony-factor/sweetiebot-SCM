'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { migrateLegacySettings } = require('../extension/ui/settings-migration');

function mockVSCode(values, folders = []) {
  const writes = [];
  const targetByField = { globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 };
  return {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
      workspaceFolders: folders.map(name => ({ uri: name })),
      getConfiguration(section, uri) {
        return {
          inspect(key) {
            return values[`${section}.${key}:${uri || ''}`] || {};
          },
          async update(key, value, target) {
            const field = Object.keys(targetByField).find(name => targetByField[name] === target);
            const lookup = `${section}.${key}:${uri || ''}`;
            const next = { ...(values[lookup] || {}), [field]: value };
            values[lookup] = next;
            writes.push({ section, key, value, target, uri });
          }
        };
      }
    },
    writes
  };
}

test('migrates explicitly configured user and resource preferences', async () => {
  const vscode = mockVSCode({
    'scmToolkit.caseOnlyRenameDetection:': { globalValue: false },
    'scmToolkit.caseOnlyRenameDetection:root': { workspaceFolderValue: false },
    'scmToolkit.gitGraphRelativeDates:': { globalValue: true }
  }, ['root']);
  await migrateLegacySettings(vscode);
  assert.deepEqual(vscode.writes.filter(x => x.key === 'caseOnlyRenameDetection').map(x => x.target), [1, 3]);
  assert.equal(vscode.writes.find(x => x.key === 'gitGraphRelativeDates').value, true);
});

test('does not overwrite an explicit new namespace preference', async () => {
  const vscode = mockVSCode({
    'scmToolkit.caseOnlyRenameDetection:': { globalValue: false },
    'sweetiebot.caseOnlyRenameDetection:': { globalValue: true }
  });
  await migrateLegacySettings(vscode);
  assert.equal(vscode.writes.length, 0);
});
