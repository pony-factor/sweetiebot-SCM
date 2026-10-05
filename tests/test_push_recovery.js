'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPushErrorHandler, registerPushRecovery } = require('../efs/push_recovery');

const rejected = reason => Object.assign(new Error('Git error'), {
  gitErrorCode: 'PushRejected', stderr: ` ! [rejected] main -> main (${reason})`
});
const head = () => ({ name: 'main', upstream: { remote: 'origin', name: 'main' } });

async function run() {
  const handler = createPushErrorHandler();
  const calls = [];
  const repository = {
    rootUri: { toString: () => 'file:///test' }, state: { HEAD: head() },
    async status() {},
    async fetch(options) { calls.push(['fetch', options]); },
    async merge(ref) { calls.push(['merge', ref]); },
    async push(remote, refspec) { calls.push(['push', remote, refspec]); }
  };
  const invoke = (error = rejected('non-fast-forward'), repo = repository, refspec = 'main:main') =>
    handler.handlePushError(repo, { name: 'origin' }, refspec, error);
  for (const reason of ['non-fast-forward', 'fetch first']) {
    assert.equal(await invoke(rejected(reason)), true);
    assert.deepEqual(calls.splice(0), [
      ['fetch', { remote: 'origin', ref: 'main' }],
      ['merge', 'refs/remotes/origin/main'], ['push', 'origin', 'main:main']
    ]);
  }
  for (const error of [new Error('permission denied'), rejected('hook declined'),
    { ...rejected('non-fast-forward'), gitErrorCode: 'ForcePushWithLeaseRejected' }]) {
    assert.equal(await invoke(error), false);
  }
  assert.equal(await invoke(undefined, repository, 'other:main'), false);
  repository.state.HEAD = { name: 'main' };
  assert.equal(await invoke(), false);
  repository.state.HEAD = head();
  assert.deepEqual(calls, []);
  const fetch = repository.fetch;
  repository.fetch = async () => { repository.state.HEAD = { ...head(), name: 'other' }; };
  await assert.rejects(invoke(), /active branch changed/);
  assert.deepEqual(calls, []);
  repository.fetch = fetch;
  repository.state.HEAD = head();
  const merge = repository.merge;
  repository.merge = async () => { throw new Error('merge conflict'); };
  await assert.rejects(invoke(), /merging origin\/main encountered conflicts/);
  assert.equal(calls.splice(0).length, 1, 'Conflicts prevent retrying the push');
  repository.merge = merge;
  for (const [failure, expected] of [
    [{ gitErrorCode: 'Conflict', stdout: 'CONFLICT (content): Merge conflict in file.txt' }, /merging origin\/main encountered conflicts.*Resolve.*complete the merge/],
    [{ stderr: 'fatal: You have not concluded your merge (MERGE_HEAD exists).' }, /merge is unfinished.*finish or abort/],
    [{ stderr: 'error: rebase is in progress' }, /rebase is in progress.*finish or abort/],
    [{ message: 'Git error' }, /Push paused while merging origin\/main.*Open Git Output/]
  ]) {
    repository.merge = async () => { throw Object.assign(new Error('Git error'), failure); };
    await assert.rejects(invoke(), error => expected.test(error.message) && Boolean(error.cause));
    calls.length = 0;
  }
  repository.merge = merge;
  const push = repository.push;
  repository.push = async () => {
    assert.equal(await invoke(undefined, { ...repository }), false,
      'A new Git API wrapper for the same repository cannot trigger recursive recovery');
    throw new Error('remote advanced again');
  };
  await assert.rejects(invoke(), /remote advanced again/);
  calls.length = 0;
  repository.push = push;
  assert.equal(await invoke(), true, 'A failed recovery releases its guard for later pushes');

  const subscriptions = [];
  const disposable = { dispose() {} };
  await registerPushRecovery({ extensions: { getExtension(id) {
    assert.equal(id, 'vscode.git');
    return { async activate() { return { getAPI(version) {
      assert.equal(version, 1);
      return { registerPushErrorHandler(value) {
        assert.equal(typeof value.handlePushError, 'function');
        return disposable;
      } };
    } }; } };
  } } }, { subscriptions });
  assert.deepEqual(subscriptions, [disposable]);

  // Exercise the extension-host callback with real Git, including divergent main.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-push-recovery-'));
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
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
    git(directory, 'init', '--bare', '--initial-branch=main', remote);
    git(directory, 'clone', remote, local);
    configure(local);
    fs.writeFileSync(path.join(local, 'base.txt'), 'base\n');
    git(local, 'add', 'base.txt');
    git(local, 'commit', '-m', 'Base');
    git(local, 'push', '-u', 'origin', 'main');
    git(directory, 'clone', remote, other);
    configure(other);
    git(local, 'config', 'pull.ff', 'only');
    git(local, 'config', 'pull.rebase', 'true');
    fs.writeFileSync(path.join(local, 'local.txt'), 'local\n');
    git(local, 'add', 'local.txt');
    git(local, 'commit', '-m', 'Local');
    const localCommit = git(local, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(other, 'remote.txt'), 'remote\n');
    git(other, 'add', 'remote.txt');
    git(other, 'commit', '-m', 'Remote');
    git(other, 'push');
    const remoteCommit = git(other, 'rev-parse', 'HEAD');
    let attempts = 0;
    const real = {
      rootUri: { toString: () => local }, state: { HEAD: head() },
      async status() {},
      async fetch(options) { git(local, 'fetch', options.remote, options.ref); },
      async merge(ref) { git(local, 'merge', '--no-edit', ref); },
      async push(remoteName, refspec) {
        attempts++;
        try { git(local, 'push', remoteName, refspec); }
        catch (error) {
          error.gitErrorCode = 'PushRejected';
          error.stderr = error.stderr.toString();
          if (!await handler.handlePushError({ ...real }, { name: remoteName }, refspec, error)) throw error;
        }
      }
    };
    await real.push('origin', 'main:main');
    assert.equal(attempts, 2);
    assert.equal(git(local, 'rev-parse', 'HEAD'), git(directory, '--git-dir', remote, 'rev-parse', 'main'));
    assert.equal(git(local, 'rev-parse', 'HEAD^1'), localCommit);
    assert.equal(git(local, 'rev-parse', 'HEAD^2'), remoteCommit);
    assert.equal(git(local, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Extension-host push recovery regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
