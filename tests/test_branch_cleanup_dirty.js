'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { deleteBranch } = require('../efs/branch_actions');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-cleanup-test-'));
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true' }
}).trim();

function fixture(name) {
  const root = path.join(directory, name);
  fs.mkdirSync(root);
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, local);
  git(local, 'config', 'user.name', 'Test');
  git(local, 'config', 'user.email', 'test@example.invalid');
  git(local, 'config', 'core.hooksPath', '/dev/null');
  const file = path.join(local, 'control.txt');
  fs.writeFileSync(file, 'old control\n');
  git(local, 'add', 'control.txt');
  git(local, 'commit', '-m', 'Base');
  git(local, 'push', '-u', 'origin', 'main');
  git(local, 'checkout', '-b', 'topic');
  fs.writeFileSync(file, 'merged control\n');
  git(local, 'add', 'control.txt');
  git(local, 'commit', '-m', 'Merged fix');
  git(local, 'push', 'origin', 'topic:main');
  const merged = git(local, 'rev-parse', 'HEAD');
  fs.writeFileSync(file, 'staged follow-up\n');
  git(local, 'add', 'control.txt');
  fs.writeFileSync(file, 'unstaged follow-up\n');
  fs.writeFileSync(path.join(local, 'draft.txt'), 'untracked draft\n');
  const snapshot = () => ({
    index: git(local, 'ls-files', '--stage'),
    working: fs.readFileSync(file, 'utf8'),
    untracked: fs.readFileSync(path.join(local, 'draft.txt'), 'utf8')
  });
  const repository = {
    rootUri: { fsPath: local }, state: {},
    async status() { this.state.HEAD = { name: git(local, 'branch', '--show-current') }; },
    async fetch({ remote: target, ref, prune }) {
      git(local, 'fetch', target, ...(ref ? [ref] : []), ...(prune ? ['--prune'] : []));
    },
    async getRefs({ pattern }) {
      return git(local, 'for-each-ref', '--format=%(refname:short)', pattern)
        .split('\n').filter(Boolean).map(name => ({ name }));
    },
    async getBranch(name) {
      const upstream = git(local, 'rev-parse', '--abbrev-ref', `${name}@{upstream}`);
      return { name, upstream: { remote: upstream.split('/')[0], name: upstream.split('/').slice(1).join('/') } };
    },
    async checkout(name) { git(local, 'checkout', name); },
    async deleteBranch(name, force) { git(local, 'branch', force ? '-D' : '-d', name); }
  };
  return { root, local, remote, merged, snapshot, repository };
}

async function run() {
  const options = { branch: 'topic', defaultBranch: 'main', remote: 'origin' };
  {
    const f = fixture('compatible');
    const before = f.snapshot();
    assert.throws(() => git(f.local, 'checkout', 'main'), /would be overwritten/,
      'Reproduce the old checkout-first failure with stale main');
    assert.equal(await deleteBranch(f.repository, options), 'topic');
    assert.equal(git(f.local, 'branch', '--show-current'), 'main');
    assert.equal(git(f.local, 'rev-parse', 'main'), f.merged);
    assert.equal(git(f.local, 'branch', '--list', 'topic'), '');
    assert.deepEqual(f.snapshot(), before, 'Preserve partial staging, working bytes, and untracked draft');
  }
  {
    const f = fixture('conflict');
    const writer = path.join(f.root, 'writer');
    git(f.root, 'clone', f.remote, writer);
    git(writer, 'config', 'user.name', 'Test');
    git(writer, 'config', 'user.email', 'test@example.invalid');
    git(writer, 'config', 'core.hooksPath', '/dev/null');
    fs.writeFileSync(path.join(writer, 'control.txt'), 'incoming conflicting control\n');
    git(writer, 'add', 'control.txt');
    git(writer, 'commit', '-m', 'Incoming edit');
    git(writer, 'push');
    const before = f.snapshot();
    await assert.rejects(deleteBranch(f.repository, options), /would be overwritten/);
    assert.equal(git(f.local, 'branch', '--show-current'), 'topic');
    assert.equal(git(f.local, 'rev-parse', 'topic'), f.merged);
    assert.deepEqual(f.snapshot(), before);
  }
  {
    const f = fixture('held-main');
    const before = f.snapshot();
    git(f.local, 'worktree', 'add', path.join(f.root, 'held'), 'main');
    await assert.rejects(deleteBranch(f.repository, options), /checked out/);
    assert.equal(git(f.local, 'branch', '--show-current'), 'topic');
    assert.equal(git(f.local, 'rev-parse', 'topic'), f.merged);
    assert.deepEqual(f.snapshot(), before);
  }
  console.log('One-click cleanup preserves local edits and staging with stale main; conflicts and held branches stay protected.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
