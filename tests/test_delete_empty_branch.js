'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { deleteEmptyBranch } = require('../efs/branch_actions');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-delete-empty-'));
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
}).trim();

function fixture(name, published = false) {
  const base = path.join(directory, name);
  fs.mkdirSync(base);
  const remote = path.join(base, 'remote.git');
  const local = path.join(base, 'local');
  git(base, 'init', '--bare', '--initial-branch=main', remote);
  git(base, 'clone', remote, local);
  git(local, 'config', 'user.name', 'Test');
  git(local, 'config', 'user.email', 'test@example.invalid');
  git(local, 'config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(local, 'base.txt'), 'base\n');
  git(local, 'add', '.');
  git(local, 'commit', '-m', 'Initial');
  git(local, 'push', '-u', 'origin', 'main');
  git(local, 'checkout', '-b', 'topic');
  if (published) git(local, 'push', '-u', 'origin', 'topic');
  const repository = {
    rootUri: { fsPath: local }, state: {},
    async status() { this.state.HEAD = { name: git(local, 'branch', '--show-current') }; },
    async getBranch(branch) {
      assert.equal(branch, 'main');
      return { upstream: { remote: 'origin', name: 'main' } };
    },
    async fetch({ remote: target, ref }) {
      git(local, 'fetch', target, ref);
    },
    async checkout(branch) { git(local, 'checkout', branch); await this.status(); },
    async deleteBranch(branch, force) { git(local, 'branch', force ? '-D' : '-d', branch); }
  };
  const remoteBranch = () => git(base, '--git-dir', remote, 'branch', '--list', 'topic');
  const localBranch = () => git(local, 'branch', '--list', 'topic');
  return { base, remote, local, repository, remoteBranch, localBranch };
}

async function run() {
  const opts = { branch: 'topic', defaultBranch: 'main', remote: 'origin' };
  {
    const f = fixture('local-only');
    assert.deepEqual(await deleteEmptyBranch(f.repository, opts), { branch: 'topic', remoteDeleted: false });
    assert.equal(f.localBranch(), '');
    assert.equal(f.remoteBranch(), '');
    assert.equal(git(f.local, 'branch', '--show-current'), 'main');
  }
  {
    const f = fixture('published', true);
    assert.deepEqual(await deleteEmptyBranch(f.repository, opts), { branch: 'topic', remoteDeleted: true });
    assert.equal(f.localBranch(), '');
    assert.equal(f.remoteBranch(), '');
  }
  {
    // Deleting a stale empty branch should not rewrite unpublished main commits.
    const f = fixture('local-main-ahead', true);
    git(f.local, 'checkout', 'main');
    fs.writeFileSync(path.join(f.local, 'base.txt'), 'local advance\n');
    git(f.local, 'commit', '-am', 'Main only');
    const newMain = git(f.local, 'rev-parse', 'HEAD');
    git(f.local, 'checkout', 'topic');
    assert.equal((await deleteEmptyBranch(f.repository, opts)).remoteDeleted, true);
    assert.equal(git(f.local, 'rev-parse', 'main'), newMain);
    assert.equal(f.localBranch(), '');
  }
  {
    const f = fixture('topic-commits', true);
    fs.writeFileSync(path.join(f.local, 'topic.txt'), 'unique commit\n');
    git(f.local, 'add', '.');
    git(f.local, 'commit', '-m', 'Unique topic');
    await assert.rejects(deleteEmptyBranch(f.repository, opts), /contains commits/);
    assert(f.localBranch());
    assert(f.remoteBranch());
    assert.equal(git(f.local, 'branch', '--show-current'), 'topic');
  }
  {
    const f = fixture('dirty', true);
    fs.writeFileSync(path.join(f.local, 'draft.txt'), 'do not drop this\n');
    await assert.rejects(deleteEmptyBranch(f.repository, opts), /Commit, stash, or discard/);
    assert(f.localBranch());
    assert(f.remoteBranch());
    assert.equal(fs.readFileSync(path.join(f.local, 'draft.txt'), 'utf8'), 'do not drop this\n');
  }
  {
    const f = fixture('remote-ahead', true);
    const other = path.join(f.base, 'other');
    git(f.base, 'clone', f.remote, other);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.invalid');
    git(other, 'checkout', 'topic');
    fs.writeFileSync(path.join(other, 'new.txt'), 'remote change\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'Remote unique');
    git(other, 'push');
    await assert.rejects(deleteEmptyBranch(f.repository, opts), /tip differs/);
    assert(f.localBranch());
    assert(f.remoteBranch());
    assert.equal(git(f.local, 'branch', '--show-current'), 'topic');
  }
  {
    // A remote push between preflight and deletion must defeat the exact-SHA lease.
    const f = fixture('lease', true);
    const other = path.join(f.base, 'other');
    git(f.base, 'clone', f.remote, other);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.invalid');
    git(other, 'checkout', 'topic');
    f.repository.checkout = async branch => {
      git(f.local, 'checkout', branch);
      await f.repository.status();
      fs.writeFileSync(path.join(other, 'new.txt'), 'concurrent update\n');
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'New remote commit');
      git(other, 'push');
    };
    await assert.rejects(deleteEmptyBranch(f.repository, opts), /stale info|rejected|fetch first|failed to push/i);
    assert(f.localBranch(), 'Keep local branch if remote deletion fails');
    assert(f.remoteBranch());
  }
  {
    const f = fixture('default-guard');
    await assert.rejects(deleteEmptyBranch(f.repository, { ...opts, branch: 'main' }), /non-default/);
    assert(f.localBranch());
  }
  console.log('Empty branch deletion regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
