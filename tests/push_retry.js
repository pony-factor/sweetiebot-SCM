'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const source = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('async function scmToolkitPushWithPullRetry(');
const end = source.indexOf('\nfunction scmToolkitCreateControls(', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const retry = context.scmToolkitPushWithPullRetry;
const head = () => ({ name: 'topic', upstream: { remote: 'origin', name: 'shared' } });
const rejected = () => Object.assign(new Error('rejected'), { gitErrorCode: 'PushRejected' });

async function run() {
  const calls = [];
  const repository = {
    HEAD: head(),
    async fetch(options) { calls.push(['fetch', options.remote, options.ref]); },
    async merge(ref) { calls.push(['merge', ref]); }
  };
  const push = async function(branch) {
    assert.equal(this, repository);
    assert.equal(branch.name, 'topic');
    calls.push(['push']);
    if (calls.length === 1) throw rejected();
  };
  await retry(repository, push);
  assert.deepEqual(calls, [
    ['push'], ['fetch', 'origin', 'shared'], ['merge', 'refs/remotes/origin/shared'], ['push']
  ]);
  calls.length = 0;
  await retry(repository, async () => calls.push(['push']));
  assert.deepEqual(calls, [['push']], 'Successful pushes do not fetch or merge');
  calls.length = 0;
  const denied = new Error('permission denied');
  await assert.rejects(retry(repository, async () => { throw denied; }), error => error === denied);
  assert.deepEqual(calls, [], 'Other push failures never trigger a merge');
  repository.HEAD = { name: 'topic' };
  await assert.rejects(retry(repository, async () => { throw rejected(); }), /rejected/);
  assert.deepEqual(calls, [], 'Branches without an upstream never guess a merge target');
  repository.HEAD = head();
  repository.fetch = async () => { repository.HEAD = { ...head(), name: 'another' }; };
  await assert.rejects(retry(repository, async () => { throw rejected(); }), /active branch changed/);
  assert.deepEqual(calls, [], 'Switching branches during fetch prevents merging and retrying');
  repository.HEAD = head();
  repository.fetch = async () => {};
  const conflict = new Error('conflict');
  repository.merge = async () => { throw conflict; };
  let pushes = 0;
  await assert.rejects(retry(repository, async () => { pushes++; throw rejected(); }), error => error === conflict);
  assert.equal(pushes, 1, 'Merge conflicts prevent a second push');

  // Reproduce divergence with actual Git, including settings that make plain pull fail.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-push-retry-'));
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
  }).trim();
  const configure = cwd => {
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'user.email', 'test@example.invalid');
    git(cwd, 'config', 'core.hooksPath', '/dev/null');
  };
  try {
    const remote = path.join(directory, 'remote.git');
    const local = path.join(directory, 'local');
    const other = path.join(directory, 'other');
    git(directory, 'init', '--bare', '--initial-branch=shared', remote);
    git(directory, 'clone', remote, local);
    configure(local);
    fs.writeFileSync(path.join(local, 'base.txt'), 'base\n');
    git(local, 'add', 'base.txt');
    git(local, 'commit', '-m', 'Base');
    git(local, 'push', '-u', 'origin', 'shared');
    git(directory, 'clone', remote, other);
    configure(other);
    git(local, 'checkout', '-b', 'topic');
    git(local, 'branch', '--set-upstream-to=origin/shared');
    git(local, 'config', 'pull.ff', 'only');
    git(local, 'config', 'pull.rebase', 'true');
    fs.writeFileSync(path.join(local, 'local.txt'), 'local\n');
    git(local, 'add', 'local.txt');
    git(local, 'commit', '-m', 'Local');
    const localCommit = git(local, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(other, 'upstream.txt'), 'upstream\n');
    git(other, 'add', 'upstream.txt');
    git(other, 'commit', '-m', 'Upstream');
    git(other, 'push');
    const upstreamCommit = git(other, 'rev-parse', 'HEAD');
    let attempts = 0;
    const real = {
      HEAD: head(),
      async fetch(options) { git(local, 'fetch', options.remote, options.ref); },
      async merge(ref) { git(local, 'merge', '--no-edit', ref); }
    };
    await retry(real, async branch => {
      attempts++;
      try { git(local, 'push', branch.upstream.remote, `${branch.name}:${branch.upstream.name}`); }
      catch (error) {
        if (/\[rejected\]/.test(error.stderr.toString())) error.gitErrorCode = 'PushRejected';
        throw error;
      }
    });
    assert.equal(attempts, 2);
    assert.equal(git(local, 'rev-parse', 'HEAD'), git(directory, '--git-dir', remote, 'rev-parse', 'shared'));
    assert.equal(git(local, 'rev-parse', 'HEAD^1'), localCommit, 'Existing local commit is preserved');
    assert.equal(git(local, 'rev-parse', 'HEAD^2'), upstreamCommit, 'Upstream commit is preserved');
    assert.equal(fs.readFileSync(path.join(local, 'upstream.txt'), 'utf8'), 'upstream\n');
    assert.equal(git(local, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Automatic upstream merge and push retry checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
