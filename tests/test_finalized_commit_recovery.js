'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { recoveryPlan } = require('../efs/commits/finalized_commit_recovery');
const { autoPullClean } = require('../efs/branches/branch_actions');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-finalized-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'core.hooksPath', '/dev/null');
    fs.writeFileSync(path.join(root, 'story.txt'), 'base\n');
    git('add', '.'); git('commit', '-qm', 'Base');
    fs.writeFileSync(path.join(root, 'story.txt'), 'captured\n');
    git('add', '.'); git('commit', '-qm', 'placeholder_0123456789abcdef');
    const placeholder = git('rev-parse', 'HEAD');
    git('branch', 'saved-placeholder');
    // Only test fixtures amend history to model the existing message worker.
    git('commit', '--amend', '-qm', '📖 Record captured story');
    const finalized = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', finalized);
    git('reset', '--hard', placeholder);
    fs.writeFileSync(path.join(root, 'local.txt'), 'preserve local work\n');
    git('add', '.'); git('commit', '-qm', 'Preserve local descendant');
    const descendant = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    assert.deepEqual(await recoveryPlan(root, 'main', 'refs/remotes/origin/main'), {
      branch: 'main', local: descendant, remote: finalized, tree
    });
    fs.writeFileSync(path.join(root, '.git', 'sweetiebot-background-commit.json'), '{}');
    assert.equal(await recoveryPlan(root, 'main', 'refs/remotes/origin/main'), null);
    fs.unlinkSync(path.join(root, '.git', 'sweetiebot-background-commit.json'));
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'keep\n');
    assert.equal(await recoveryPlan(root, 'main', 'refs/remotes/origin/main'), null);
    fs.unlinkSync(path.join(root, 'dirty.txt'));
    const repository = {
      rootUri: { fsPath: root }, state: {},
      async status() {
        this.state = { HEAD: { name: git('branch', '--show-current'), commit: git('rev-parse', 'HEAD'),
          upstream: { remote: 'origin', name: 'main' }, ahead: 2, behind: 1 },
          indexChanges: [], workingTreeChanges: [], mergeChanges: [] };
      }
    };
    git('config', 'scm-toolkit.default-branch', 'main');
    assert.equal(await autoPullClean(repository), false, 'Creating a merge commit requires opt-in');
    assert.equal(git('rev-parse', 'HEAD'), descendant);
    git('config', 'scm-toolkit.auto-reconcile-finalized-commits', 'true');
    assert.equal(await autoPullClean(repository), true);
    assert.equal(git('rev-parse', 'HEAD^{tree}'), tree);
    assert.equal(git('log', '-1', '--format=%P'), `${descendant} ${finalized}`);
    assert.equal(git('rev-parse', 'saved-placeholder'), placeholder);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(await recoveryPlan(root, 'main', 'refs/remotes/origin/main'), null);
    // A genuinely different remote commit must not qualify.
    git('checkout', '-q', '-b', 'unrelated', finalized);
    fs.writeFileSync(path.join(root, 'remote.txt'), 'different remote work\n');
    git('add', '.'); git('commit', '-qm', 'Different remote work');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '-q', 'main');
    assert.equal(await recoveryPlan(root, 'main', 'refs/remotes/origin/main'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Finalized-history recovery checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
