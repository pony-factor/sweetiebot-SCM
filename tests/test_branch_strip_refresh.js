'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listBranchStrip } = require('../efs/branches/branch_strip');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-branch-refresh-'));
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}).trim();

async function run() {
  const remote = path.join(directory, 'remote.git');
  const local = path.join(directory, 'local');
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'clone', remote, local);
  git(local, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'Test fixture');
  git(local, 'push', 'origin', 'main');
  git(local, 'push', 'origin', 'main:deleted-remote', 'main:kept-local');
  git(local, 'branch', 'kept-local', 'origin/kept-local');
  git(local, 'tag', 'local-tag');
  git(local, 'config', 'fetch.pruneTags', 'true');
  // Simulate deletion by another clone, leaving this clone's refs stale.
  git(remote, 'update-ref', '-d', 'refs/heads/deleted-remote');
  git(remote, 'update-ref', '-d', 'refs/heads/kept-local');
  git(remote, 'update-ref', 'refs/heads/new-remote', git(remote, 'rev-parse', 'main'));
  const repository = { rootUri: { fsPath: local } };
  const options = { defaultBranch: 'main' };
  // The local-first pass must not depend on origin or GitHub authentication.
  const localFirst = await listBranchStrip(repository, { ...options, localOnly: true });
  assert.equal(localFirst.remoteStatus, 'loading');
  assert.equal(localFirst.prStatus, 'loading');
  assert(localFirst.branches.length > 0);
  assert(localFirst.branches.every(branch => branch.local && !branch.origin));
  const result = await listBranchStrip(repository, options);
  assert.equal(result.remoteStatus, 'available');
  assert(!result.branches.some(branch => branch.name === 'deleted-remote'));
  assert(result.branches.some(branch => branch.name === 'new-remote' && branch.origin));
  const kept = result.branches.find(branch => branch.name === 'kept-local');
  assert(kept.local);
  assert.equal(kept.origin, false, 'Preserve local branch but remove its deleted origin badge');
  assert.equal(git(local, 'tag', '--list'), 'local-tag', 'Do not prune local tags');

  // Another deletion after the first popup refresh must disappear on the next one.
  git(remote, 'update-ref', '-d', 'refs/heads/new-remote');
  assert(!(await listBranchStrip(repository, options)).branches
    .some(branch => branch.name === 'new-remote'));

  git(local, 'remote', 'set-url', 'origin', path.join(directory, 'missing.git'));
  const offline = await listBranchStrip(repository, options);
  assert.equal(offline.remoteStatus, 'unavailable');
  assert(offline.branches.length > 0);
  assert(offline.branches.every(branch => branch.local && !branch.origin),
    'Do not present unverified cached remote refs when fetch fails');
  console.log('branch strip refresh tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
