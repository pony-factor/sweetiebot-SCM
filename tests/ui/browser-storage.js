'use strict';
const assert = require('node:assert/strict');
const { configureWorkspaceBrowserStorage } = require('../../extension/ui/browser-storage');

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
  // Exercise the real injected persistence helper without reading login data.
  const fs = require('node:fs'), vm = require('node:vm');
  const listeners = [], writes = [];
  const session = { cookies: { on(event, callback) { listeners.push(callback); },
    async set(cookie) { writes.push(cookie); }, async flushStore() {} } };
  const helper = vm.createContext({ Symbol, Date, Map, JSON });
  vm.runInContext(fs.readFileSync(require.resolve('../../assets/browser/session-persistence.js'), 'utf8'), helper);
  helper.sweetiebotPersistChatSession(session);
  helper.sweetiebotPersistChatSession(session);
  assert.equal(listeners.length, 2, 'Only one persistence helper per shared session');
  const cookie = { domain: '.chatgpt.com', path: '/', name: 'disposable-test', value: 'synthetic',
    session: true, secure: true, httpOnly: true, sameSite: 'lax', hostOnly: false };
  listeners[0](null, cookie, 'explicit', false);
  await new Promise(setImmediate);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].httpOnly, true);
  assert.equal(writes[0].sameSite, 'lax');
  assert.equal(writes[0].domain, '.chatgpt.com');
  assert(writes[0].expirationDate > Date.now() / 1000);
  listeners[0](null, { ...cookie, session: false, expirationDate: 1 }, 'explicit', false);
  listeners[0](null, { ...cookie, domain: '.example.com' }, 'explicit', false);
  listeners[0](null, cookie, 'explicit', false);
  listeners[0](null, cookie, 'explicit', true);
  await new Promise(setImmediate);
  assert.equal(writes.length, 1, 'Preserve server expiry, isolate other sites, and never resurrect logout removals');
  console.log('Workspace-partitioned Integrated Browser configuration checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
