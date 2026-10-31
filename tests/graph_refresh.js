'use strict';

const assert = require('node:assert/strict');
const { registerGraphStartupRefresh } = require('../extension/branches/graph_refresh');

async function run() {
  const context = { subscriptions: [] };
  const statuses = [];
  const timers = new Map();
  let nextTimer = 0;
  let onOpen, onFolders;
  const repository = name => ({
    rootUri: { scheme: 'file', fsPath: '/work/' + name },
    async status() { statuses.push(name); }
  });
  const startup = repository('startup');
  const api = {
    repositories: [startup],
    onDidOpenRepository(callback) { onOpen = callback; return { dispose() {} }; }
  };
  const vscode = {
    extensions: { getExtension(name) {
      assert.equal(name, 'vscode.git');
      return { async activate() { return { getAPI(version) {
        assert.equal(version, 1);
        return api;
      } }; } };
    } },
    workspace: { onDidChangeWorkspaceFolders(callback) {
      onFolders = callback;
      return { dispose() {} };
    } },
    commands: { executeCommand() { throw Error('Must not use git.refresh or open a picker'); } }
  };
  const options = {
    setTimer(callback) { const timer = ++nextTimer; timers.set(timer, callback); return timer; },
    clearTimer(timer) { timers.delete(timer); }
  };
  await registerGraphStartupRefresh(vscode, context, options);
  assert.deepEqual(statuses, ['startup'], 'First graph opens with an initial status scan');
  onOpen(startup);
  await Promise.resolve();
  assert.deepEqual(statuses, ['startup'], 'Repeated discovery must not rescan the same repository');
  const late = repository('late');
  api.repositories.push(late);
  onOpen(late);
  await Promise.resolve();
  onFolders();
  await Promise.resolve();
  assert.deepEqual(statuses, ['startup', 'late'], 'Late workspace repositories refresh automatically once');
  onOpen({ rootUri: { scheme: 'vscode-remote' }, async status() { throw Error('Remote repository'); } });
  await Promise.resolve();
  assert.deepEqual(statuses, ['startup', 'late'], 'Do not touch unsupported repository schemes');

  let failures = 0;
  const flaky = { rootUri: { scheme: 'file' }, async status() {
    failures++;
    if (failures < 3) throw Error('Git initializing');
  } };
  onOpen(flaky);
  await Promise.resolve();
  assert.equal(timers.size, 1, 'A failed startup scan schedules a bounded retry');
  for (let attempt = 0; attempt < 2; attempt++) {
    const [id, callback] = [...timers][0];
    timers.delete(id);
    callback();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(failures, 3);
  assert.equal(timers.size, 0);
  onOpen(flaky);
  await Promise.resolve();
  assert.equal(failures, 3, 'A successful refresh is not repeated');

  const broken = { rootUri: { scheme: 'file' }, async status() { throw Error('still broken'); } };
  onOpen(broken);
  await Promise.resolve();
  assert.equal(timers.size, 1);
  for (const disposable of context.subscriptions) disposable.dispose();
  assert.equal(timers.size, 0, 'Disposal cancels pending retries');
  onOpen(repository('after-dispose'));
  await Promise.resolve();
  assert.deepEqual(statuses, ['startup', 'late']);
  console.log('Git graph startup, late discovery, retry and disposal checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
