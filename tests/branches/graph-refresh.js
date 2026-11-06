'use strict';

const assert = require('node:assert/strict');
const { registerGraphStartupRefresh } = require('../../extension/branches/graph-refresh');

async function run() {
  const context = { subscriptions: [] };
  const statuses = [];
  const timers = new Map();
  let nextTimer = 0;
  let onOpen, onClose, onFolders;
  const repository = (name, options = {}) => ({
    rootUri: { scheme: 'file', fsPath: '/work/' + name },
    state: { HEAD: { commit: 'a'.repeat(40) } },
    ...options,
    async status() { statuses.push(name); }
  });
  const startup = repository('startup');
  const api = {
    repositories: [startup],
    onDidOpenRepository(callback) { onOpen = callback; return { dispose() {} }; },
    onDidCloseRepository(callback) { onClose = callback; return { dispose() {} }; }
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
  const fireTimer = async () => {
    const [id, callback] = [...timers][0];
    timers.delete(id);
    callback();
    await Promise.resolve();
    await Promise.resolve();
  };
  await registerGraphStartupRefresh(vscode, context, options);
  assert.deepEqual(statuses, ['startup'], 'First graph opens with an initial status scan');
  onOpen(repository('startup'));
  await Promise.resolve();
  assert.deepEqual(statuses, ['startup'], 'New Git wrappers of the same root must not repeat scans');
  const late = repository('late');
  api.repositories.push(late);
  onOpen(late);
  await Promise.resolve();
  onFolders();
  await Promise.resolve();
  assert.deepEqual(statuses, ['startup', 'late'], 'Late workspace repositories refresh once');
  onOpen({ rootUri: { scheme: 'vscode-remote', fsPath: '/remote' }, async status() {
    throw Error('Remote repository');
  } });
  await Promise.resolve();
  assert.deepEqual(statuses, ['startup', 'late'], 'Do not touch unsupported repository schemes');

  const worktree = repository('worktree', { kind: 'worktree' });
  onOpen(worktree);
  await Promise.resolve();
  assert.equal(timers.size, 1, 'Worktrees receive a delayed graph initialization scan');
  await fireTimer();
  assert.deepEqual(statuses.slice(-2), ['worktree', 'worktree']);
  assert.equal(timers.size, 0, 'Successful delayed scan is final');
  onOpen(repository('worktree', { kind: 'worktree' }));
  await Promise.resolve();
  assert.equal(statuses.filter(x => x === 'worktree').length, 2, 'Worktree scans remain bounded');

  let headAttempts = 0;
  const missingHead = repository('head', { state: { HEAD: undefined } });
  missingHead.status = async () => {
    headAttempts++;
    if (headAttempts === 2) missingHead.state.HEAD = { commit: 'a'.repeat(40) };
  };
  onOpen(missingHead);
  await Promise.resolve();
  assert.equal(timers.size, 1, 'Initial scan without HEAD is retried');
  await fireTimer();
  assert.equal(headAttempts, 2);
  assert.equal(timers.size, 0, 'HEAD recovery ends retry sequence');

  let failures = 0;
  const flaky = repository('flaky');
  flaky.status = async () => {
    failures++;
    if (failures < 3) throw Error('Git initializing');
  };
  onOpen(flaky);
  await Promise.resolve();
  assert.equal(timers.size, 1, 'Failed scan schedules a bounded retry');
  await fireTimer();
  await fireTimer();
  assert.equal(failures, 3);
  assert.equal(timers.size, 0);
  onOpen(flaky);
  await Promise.resolve();
  assert.equal(failures, 3, 'Successful refresh is not repeated');

  const reopened = repository('reopened', { kind: 'worktree' });
  onOpen(reopened);
  await Promise.resolve();
  assert.equal(timers.size, 1);
  onClose(reopened);
  assert.equal(timers.size, 0, 'Closing a worktree cancels its retry');
  onOpen(reopened);
  await Promise.resolve();
  assert.equal(statuses.filter(x => x === 'reopened').length, 2, 'Reopening rescans the worktree');

  const broken = repository('broken');
  broken.status = async () => { throw Error('still broken'); };
  onOpen(broken);
  await Promise.resolve();
  assert.equal(timers.size, 2);
  for (const disposable of context.subscriptions) disposable.dispose();
  assert.equal(timers.size, 0, 'Disposal cancels pending retries');
  onOpen(repository('after-dispose'));
  await Promise.resolve();
  assert.equal(statuses.includes('after-dispose'), false);
  console.log('Git graph startup, linked worktree, HEAD recovery, retry and disposal checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
