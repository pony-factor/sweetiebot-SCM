'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBranch } = require('../efs/branch_actions');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-background-test-'));
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true' }
}).trim();

async function run() {
  const remote = path.join(directory, 'remote.git');
  const local = path.join(directory, 'local');
  const other = path.join(directory, 'other');
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'clone', remote, local);
  for (const root of [local]) {
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'core.hooksPath', '/dev/null');
  }
  fs.writeFileSync(path.join(local, 'base.txt'), 'base\n');
  git(local, 'add', 'base.txt');
  git(local, 'commit', '-m', 'Base');
  git(local, 'push', '-u', 'origin', 'main');
  git(directory, 'clone', remote, other);
  git(other, 'config', 'user.name', 'Test');
  git(other, 'config', 'user.email', 'test@example.invalid');
  git(other, 'config', 'core.hooksPath', '/dev/null');
  git(local, 'checkout', '-b', 'topic');
  const checkouts = [];
  const repository = {
    rootUri: { fsPath: local }, state: {},
    async status() { this.state.HEAD = { name: git(local, 'branch', '--show-current') }; },
    async getRefs() { return git(local, 'for-each-ref', '--format=%(refname:short)').split('\n').map(name => ({ name })); },
    async createBranch(name, checkout, base) {
      checkouts.push(name);
      git(local, 'checkout', '-b', name, base);
      await this.status();
    },
    async checkout() { throw new Error('Must never switch the current worktree to main'); }
  };
  const options = { defaultBranch: 'main', remote: 'origin', names: ['fresh'] };
  fs.writeFileSync(path.join(other, 'remote.txt'), 'remote\n');
  git(other, 'add', 'remote.txt');
  git(other, 'commit', '-m', 'Remote');
  git(other, 'push');
  const remoteTip = git(other, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(local, 'draft.txt'), 'Keep my draft\n');
  assert.equal(await createBranch(repository, options), 'fresh');
  assert.equal(git(local, 'rev-parse', 'HEAD'), remoteTip);
  assert.equal(git(local, 'rev-parse', 'main'), remoteTip);
  assert.deepEqual(checkouts, ['fresh']);
  assert.equal(fs.readFileSync(path.join(local, 'draft.txt'), 'utf8'), 'Keep my draft\n');
  assert.equal(git(local, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);

  // Divergent main merges and pushes in the temporary worktree, preserving both tips.
  git(local, 'checkout', 'main');
  fs.writeFileSync(path.join(local, 'local.txt'), 'local\n');
  git(local, 'add', 'local.txt');
  git(local, 'commit', '-m', 'Local');
  const localTip = git(local, 'rev-parse', 'HEAD');
  git(local, 'checkout', 'topic');
  fs.writeFileSync(path.join(other, 'remote.txt'), 'remote update\n');
  git(other, 'add', 'remote.txt');
  git(other, 'commit', '-m', 'Remote update');
  git(other, 'push');
  const secondRemoteTip = git(other, 'rev-parse', 'HEAD');
  await createBranch(repository, { ...options, names: ['second'] });
  assert.equal(git(local, 'rev-parse', 'HEAD^1'), localTip);
  assert.equal(git(local, 'rev-parse', 'HEAD^2'), secondRemoteTip);
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(directory, '--git-dir', remote, 'rev-parse', 'main'));

  // A background conflict must leave the user's branch and draft untouched.
  git(other, 'fetch');
  git(other, 'merge', '--ff-only', 'origin/main');
  git(local, 'checkout', 'main');
  fs.writeFileSync(path.join(local, 'base.txt'), 'local conflict\n');
  git(local, 'add', 'base.txt');
  git(local, 'commit', '-m', 'Local conflict');
  const conflictedMain = git(local, 'rev-parse', 'main');
  git(local, 'checkout', 'topic');
  fs.writeFileSync(path.join(other, 'base.txt'), 'remote conflict\n');
  git(other, 'add', 'base.txt');
  git(other, 'commit', '-m', 'Remote conflict');
  git(other, 'push');
  await assert.rejects(createBranch(repository, { ...options, names: ['blocked'] }), /changes conflict.*current branch was preserved/);
  assert.equal(git(local, 'branch', '--show-current'), 'topic');
  assert.equal(git(local, 'rev-parse', 'main'), conflictedMain);
  assert.deepEqual(checkouts, ['fresh', 'second']);
  assert.equal(git(local, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  assert.equal(fs.readFileSync(path.join(local, 'draft.txt'), 'utf8'), 'Keep my draft\n');
  console.log('Background branch creation regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
