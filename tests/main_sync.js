'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { syncBranch } = require('../extension/branches/actions');

async function run() {
  // Exercise the actual button handler, including its disabled state and feedback.
  const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
  const start = source.indexOf('    const refreshSyncBranch = () => {');
  const end = source.indexOf('    const refreshBranchControls = () => {', start);
  const calls = [], notices = [];
  const context = vm.createContext({
    currentBranch: 'main', currentDefaultBranch: 'main', currentRepositoryUri: 'repo',
    pending: false, deletingBranch: false, creatingPullRequest: false, creatingPonyBranch: false,
    updatingPush: false, pushCheckbox: {}, settings: { remote: 'origin' },
    syncButton: { setAttribute() {} }, refreshBranchControls() {},
    notifications: { info(message) { notices.push(message); }, error(error) { throw error; } },
    commands: { async executeCommand(...args) { calls.push(args); return 'main'; } }
  });
  vm.runInContext(source.slice(start, end) + '\nthis.refresh = refreshSyncBranch; this.click = syncBranch;', context);
  context.refresh();
  assert.equal(context.syncButton.disabled, false);
  assert.match(context.syncButton.title, /upstream/);
  await context.click({ stopPropagation() {}, altKey: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'sweetiebot.syncBranch');
  assert.equal(calls[0][2].branch, 'main');
  assert.equal(notices[0], 'Synced main with its upstream branch.');
  context.pending = true;
  context.refresh();
  assert.equal(context.syncButton.disabled, true);
  await context.click({ stopPropagation() {} });
  assert.equal(calls.length, 1);

  // Pull real upstream commits through the command and verify subsequent push.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-main-sync-'));
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true' }
  }).trim();
  try {
    const remote = path.join(directory, 'remote.git');
    const local = path.join(directory, 'local');
    const other = path.join(directory, 'other');
    git(directory, 'init', '--bare', '--initial-branch=trunk', remote);
    git(directory, 'clone', remote, other);
    git(other, 'config', 'user.name', 'Test');
    git(other, 'config', 'user.email', 'test@example.invalid');
    git(other, 'config', 'core.hooksPath', '/dev/null');
    git(other, 'commit', '--allow-empty', '-m', 'Base');
    git(other, 'push', '-u', 'origin', 'trunk');
    git(directory, 'clone', '--origin', 'upstream', remote, local);
    git(local, 'branch', '-m', 'main');
    git(local, 'config', 'user.name', 'Test');
    git(local, 'config', 'user.email', 'test@example.invalid');
    git(local, 'config', 'core.hooksPath', '/dev/null');
    git(other, 'commit', '--allow-empty', '-m', 'Remote update');
    git(other, 'push');
    const remoteTip = git(other, 'rev-parse', 'HEAD');
    const repository = {
      state: {}, inputBox: { value: 'My draft' },
      async status() {
        const [ahead, behind] = git(local, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}').split(/\s+/).map(Number);
        this.state.HEAD = { name: git(local, 'branch', '--show-current'), upstream: { remote: 'upstream', name: 'trunk' }, ahead, behind };
      },
      async fetch({ remote }) { git(local, 'fetch', remote); },
      async merge(ref) { git(local, 'merge', '--no-edit', ref); },
      async push(remote, ref) { git(local, 'push', remote, ref); }
    };
    const options = { branch: 'main', defaultBranch: 'main', remote: 'origin' };
    assert.equal(await syncBranch(repository, options), 'main');
    assert.equal(git(local, 'rev-parse', 'HEAD'), remoteTip, 'Pull fast-forwards without a squash commit');
    git(local, 'commit', '--allow-empty', '-m', 'Local update');
    const localTip = git(local, 'rev-parse', 'HEAD');
    await syncBranch(repository, options);
    assert.equal(git(directory, '--git-dir', remote, 'rev-parse', 'trunk'), localTip);
    assert.equal(git(local, 'branch', '--show-current'), 'main');
    assert.equal(repository.inputBox.value, 'My draft');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Main sync button and real upstream pull/push checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
