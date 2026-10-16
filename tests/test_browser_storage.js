'use strict';
const assert = require('node:assert/strict');
const { configureWorkspaceBrowserStorage } = require('../efs/browser_storage');

function fixture({ current = 'default', globalValue, workspaceValue, workspaceFolderValue,
    unsupported = false, fails = false } = {}) {
  const updates = [], selection = { globalValue, workspaceValue, workspaceFolderValue };
  const config = {
    get(name) { assert.equal(name, 'dataStorage'); return current; },
    inspect(name) { assert.equal(name, 'dataStorage'); return unsupported ? undefined : selection; },
    async update(name, value, target) {
      assert.equal(name, 'dataStorage');
      if (fails) throw new Error('Setting is read-only');
      updates.push([name, value, target]);
      current = value;
      selection.globalValue = value;
    }
  };
  return { updates, vscode: { ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration(name) {
      assert.equal(name, 'workbench.browser');
      return config;
    } }
  } };
}
(async () => {
  const defaults = fixture();
  assert.equal(await configureWorkspaceBrowserStorage(defaults.vscode), true);
  assert.deepEqual(defaults.updates, [['dataStorage', 'workspace', 1]]);
  assert.equal(await configureWorkspaceBrowserStorage(defaults.vscode), false);
  assert.equal(defaults.updates.length, 1);
  for (const options of [
    { current: 'workspace' }, { current: 'global', globalValue: 'global' },
    { current: 'ephemeral', globalValue: 'ephemeral' },
    { current: 'default', globalValue: 'default' },
    { workspaceValue: 'global' }, { workspaceFolderValue: 'ephemeral' },
    { unsupported: true }
  ]) {
    const explicit = fixture(options);
    assert.equal(await configureWorkspaceBrowserStorage(explicit.vscode), false);
    assert.equal(explicit.updates.length, 0);
  }
  const failed = fixture({ fails: true });
  await assert.rejects(configureWorkspaceBrowserStorage(failed.vscode), /read-only/);
  console.log('Workspace-partitioned Integrated Browser configuration checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
