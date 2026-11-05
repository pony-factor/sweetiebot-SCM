'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { groupBranchRefs, parseGitHubRemote, checkoutBranchStrip, pullRequestCacheKey } = require('../../extension/branches/strip');
const { worktreeLocations } = require('../../extension/branches/worktree-registry');

assert.equal(parseGitHubRemote('git@github.com:pony-factor/sweetiebot-SCM.git'),
  'github.com/pony-factor/sweetiebot-SCM');
assert.equal(parseGitHubRemote('https://github.com/pony-factor/sweetiebot-SCM.git'),
  'github.com/pony-factor/sweetiebot-SCM');
assert.equal(parseGitHubRemote('file:///tmp/repository'), null);
const nul = String.fromCharCode(0);
const blocks = [
  ['worktree /tmp/main repo', 'HEAD a', 'branch refs/heads/main'].join(nul),
  ['worktree /tmp/topic', 'HEAD b', 'branch refs/heads/topic/name'].join(nul),
  ['worktree /tmp/detached', 'HEAD c', 'detached'].join(nul)
].join(nul + nul);
assert.deepEqual([...worktreeLocations(blocks)],
  [['main', '/tmp/main repo'], ['topic/name', '/tmp/topic']]);
const lineForm = blocks.split(nul + nul).map(block => block.split(nul).join('\n')).join('\n\n');
assert.deepEqual([...worktreeLocations(lineForm)],
  [['main', '/tmp/main repo'], ['topic/name', '/tmp/topic']]);

const refs = [
  'refs/heads/main\t3',
  'refs/heads/working\t100',
  'refs/remotes/origin/working\t80',
  'refs/remotes/origin/remote-only\t90',
  'refs/heads/has-pr\t140',
  'refs/heads/merged\t60',
  'refs/remotes/origin/HEAD\t200',
  'refs/heads/older\t10',
  'refs/remotes/origin/older\t5'
].join('\n');
const merged = 'refs/heads/merged\nrefs/heads/main\nrefs/remotes/origin/older';
const result = groupBranchRefs(refs, merged, new Set(['has-pr']), true, 'main');
assert.equal(result.featuredCount, 3);
assert.deepEqual(result.branches.slice(0, 3).map(item => item.name),
  ['working', 'older', 'remote-only']);
assert.deepEqual(result.branches.map(item => item.name).sort(),
  ['has-pr', 'main', 'merged', 'older', 'remote-only', 'working']);
assert.deepEqual(result.branches.find(item => item.name === 'working'),
  { name: 'working', local: true, origin: true, merged: false, modified: 100,
    hasPr: false, featured: true });
assert.equal(result.branches.find(item => item.name === 'remote-only').origin, true);
assert.equal(result.branches.find(item => item.name === 'has-pr').featured, false);
assert.equal(result.branches.find(item => item.name === 'merged').featured, false);
// Remote may have merged while a local branch still contains unmerged commits.
assert.equal(result.branches.find(item => item.name === 'older').merged, false);
assert.equal(result.branches.find(item => item.name === 'main').featured, false);
const withPrDetails = groupBranchRefs(refs, merged, new Map([['has-pr', {
  number: 25, url: 'https://github.com/pony-factor/sweetiebot-SCM/pull/25', state: 'OPEN'
}]]), true, 'main');
assert.deepEqual(withPrDetails.branches.find(item => item.name === 'has-pr').pr, {
  number: 25, url: 'https://github.com/pony-factor/sweetiebot-SCM/pull/25', state: 'OPEN'
});
assert.equal(withPrDetails.branches.find(item => item.name === 'working').hasPr, false);
const unknown = groupBranchRefs(refs, merged, new Set(), false, 'main');
assert.equal(unknown.featuredCount, 0);
assert(unknown.branches.every(item => item.hasPr === null));

// Exercise the final checkout path with a real Git worktree. A routing bypass
// must never reach repository.checkout() when another worktree owns the ref.
(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-strip-occupied-'));
  const root = path.join(temporary, 'repository');
  const topic = path.join(temporary, 'occupied-topic');
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  let checkoutCalls = 0;
  try {
    git('init', '-b', 'main', root);
    git('-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'Initial commit');
    git('-C', root, 'worktree', 'add', '-b', 'occupied', topic);
    const registry = worktreeLocations(git('-C', root, 'worktree', 'list', '--porcelain'));
    assert.equal(registry.get('occupied'), topic, 'Map branch to its real checkout');
    assert.equal(registry.get('main'), root, 'Map base to its own checkout');
    const repositoryGitDir = git('-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const topicGitDir = git('-C', topic, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    assert.equal(repositoryGitDir, topicGitDir, 'Linked worktrees use one common Git database');
    const remoteUrl = 'https://github.com/pony-factor/sweetiebot-SCM.git';
    assert.equal(pullRequestCacheKey(repositoryGitDir, remoteUrl),
      pullRequestCacheKey(topicGitDir, 'git@github.com:pony-factor/sweetiebot-SCM.git'),
      'PR cache keys must be shared by linked worktrees');
    assert.notEqual(pullRequestCacheKey(repositoryGitDir, remoteUrl),
      pullRequestCacheKey(repositoryGitDir, 'https://github.com/other/repo.git'),
      'PR cache keys must separate different remotes');
    await fs.writeFile(path.join(topic, 'untracked.txt'), 'keep me\n');
    const repository = {
      rootUri: { fsPath: root },
      state: { HEAD: { name: 'main' } },
      async checkout(branch) {
        checkoutCalls++;
        this.state.HEAD.name = branch;
      },
      async status() {}
    };
    await assert.rejects(checkoutBranchStrip(repository, { branch: 'occupied' }),
      /already checked out in worktree/,
      'Without a window router, fail closed instead of attempting checkout');
    assert.equal(checkoutCalls, 0);
    let routed;
    assert.equal(await checkoutBranchStrip(repository, {
      branch: 'occupied',
      async onOccupiedWorktree(destination) {
        routed = destination;
        return true;
      }
    }), 'occupied');
    assert.equal(await fs.realpath(routed), await fs.realpath(topic),
      'Pass the exact registered checkout to the router, resolving macOS path aliases');
    assert.equal(checkoutCalls, 0, 'Never check out an occupied branch');
    await assert.rejects(checkoutBranchStrip(repository, {
      branch: 'occupied', onOccupiedWorktree: async () => false
    }), /checkout was not attempted/);
    assert.equal(checkoutCalls, 0, 'A refused handoff must fail closed');
    assert.equal(await fs.readFile(path.join(topic, 'untracked.txt'), 'utf8'), 'keep me\n');

    assert.equal(await checkoutBranchStrip(repository, { branch: 'main' }), 'main',
      'Normal checkout remains available for a branch owned by this worktree');
    assert.equal(checkoutCalls, 1);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log('branch strip grouping and occupied-worktree checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
