'use strict';

// Ordinary syncs must be reproducible Git merges with no AI-authored prose.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syncBranch } = require('../extension/branches/branch_actions');

const MESSAGE = '🔄 Sync brach to main\n\nCo-authored-by: Codex Web <noreply@openai.com>';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-routine-sync-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Human Author');
  git('config', 'user.email', 'human@example.invalid');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'common\n');
  git('add', '.'); git('commit', '-m', 'Initial');
  git('branch', 'topic');
  fs.writeFileSync(path.join(root, 'main.txt'), 'existing main work\n');
  git('add', '.'); git('commit', '-m', 'Human upstream work');
  git('switch', 'topic');
  fs.writeFileSync(path.join(root, 'topic.txt'), 'existing topic work\n');
  git('add', '.'); git('commit', '-m', 'Human topic work');
  git('update-ref', 'rextension/remotes/origin/main', git('rev-parse', 'main'));
  const repository = {
    rootUri: { fsPath: root },
    inputBox: { value: 'Human draft' },
    state: { HEAD: { name: 'topic' }, mergeChanges: [] },
    async fetch() {},
    async status() {
      this.state.mergeChanges = git('ls-files', '-u') ? [{}] : [];
      this.state.HEAD = { name: git('branch', '--show-current') };
    }
  };
  const options = { branch: 'topic', defaultBranch: 'main', remote: 'origin' };
  return { root, git, repository, options };
}

async function run() {
  for (const strategy of ['merge', 'squash']) {
    const setupData = setup();
    const { root, git, repository, options } = setupData;
    try {
      const oldTip = git('rev-parse', 'HEAD');
      assert.equal(await syncBranch(repository, { ...options, strategy }), 'topic');
      assert.notEqual(git('rev-parse', 'HEAD'), oldTip);
      assert.equal(git('log', '-1', '--format=%B').trim(), MESSAGE,
        'Sync commit contains only its fixed subject and attribution');
      assert.equal(git('show', '-s', '--format=%an', 'HEAD'), 'Human Author');
      assert.equal(git('status', '--porcelain'), '');
      assert.equal(fs.readFileSync(path.join(root, 'main.txt'), 'utf8'), 'existing main work\n');
      assert.equal(fs.readFileSync(path.join(root, 'topic.txt'), 'utf8'), 'existing topic work\n');
      assert.equal(repository.inputBox.value, 'Human draft');
      const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
      assert.equal(parents.length, strategy === 'merge' ? 3 : 2, 'Merge preserves two parents');
      const tip = git('rev-parse', 'HEAD');
      await syncBranch(repository, { ...options, strategy });
      assert.equal(git('rev-parse', 'HEAD'), tip, 'Already incorporated sync is a no-op');

      fs.writeFileSync(path.join(root, 'draft.txt'), 'Unreviewed local edit\n');
      await assert.rejects(syncBranch(repository, { ...options, strategy }), /Commit or stash/);
      assert.equal(git('rev-parse', 'HEAD'), tip);
      assert.equal(fs.readFileSync(path.join(root, 'draft.txt'), 'utf8'), 'Unreviewed local edit\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  // Conflicts must not be committed automatically under a routine sync title.
  const { root, git, repository, options } = setup();
  try {
    git('switch', 'main');
    fs.writeFileSync(path.join(root, 'shared.txt'), 'main change\n');
    git('add', '.'); git('commit', '-m', 'Conflicting main edit');
    git('update-ref', 'rextension/remotes/origin/main', git('rev-parse', 'main'));
    git('switch', 'topic');
    fs.writeFileSync(path.join(root, 'shared.txt'), 'topic change\n');
    git('add', '.'); git('commit', '-m', 'Conflicting topic edit');
    const oldTip = git('rev-parse', 'HEAD');
    await assert.rejects(syncBranch(repository, { ...options, strategy: 'merge' }));
    assert.equal(git('rev-parse', 'HEAD'), oldTip, 'Conflict cannot create a sync commit');
    assert(git('ls-files', '-u'), 'Conflict remains available for human review');
    assert.equal(repository.inputBox.value, '🔄 Sync brach to main');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('Routine sync commit and human review guards passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
