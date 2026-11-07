'use strict';

// Ordinary syncs must be reproducible Git merges with no AI-authored prose.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { syncBranch } = require('../../extension/branches/actions');
const { syncPublisher } = require('../../extension/branches/sync-main');

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
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'main'));
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
  // Exercise actual Git commits through the App writer, mocking only network
  // authorization/publication and the external conflict proposal service.
  for (const strategy of ['merge', 'squash']) {
    for (const scenario of ['clean', 'conflict', 'cancel', 'edited', 'index-changed']) {
      const { root, git, repository, options } = setup();
      try {
        if (scenario !== 'clean') {
          git('switch', 'main');
          fs.writeFileSync(path.join(root, 'shared.txt'), 'main change\n');
          git('add', '.'); git('commit', '-m', 'Conflicting main edit');
          git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'main'));
          git('switch', 'topic');
          fs.writeFileSync(path.join(root, 'shared.txt'), 'topic change\n');
          git('add', '.'); git('commit', '-m', 'Conflicting topic edit');
        }
        const before = git('rev-parse', 'HEAD');
        const main = git('rev-parse', 'main');
        let pushed = 0, proposed = 0;
        const createPublisher = () => syncPublisher(root, 'origin', {
          enabled: () => true,
          identity: async () => ({ name: 'lindsey-fixture[bot]', email: '123+lindsey-fixture[bot]@users.noreply.github.com' }),
          transport: () => ({ gitToken: async () => 'fixture-token' }),
          run: async (command, args, opts) => {
            if (args[0] === 'remote') return { stdout: 'https://github.com/owner/repo.git' };
            if (args.includes('push')) {
              pushed++;
              assert(args.includes(git('rev-parse', 'HEAD') + ':refs/heads/topic'));
              assert.equal(opts.env.GH_TOKEN, 'fixture-token');
              return { stdout: '' };
            }
            return exec(command, args, opts);
          }
        });
        const result = syncBranch(repository, { ...options, strategy, createPublisher,
          reviewConflicts: async (_, details) => { assert.equal(details.appIdentity, true); return 'lindsey'; },
          resolveConflicts: async () => {
            proposed++;
            assert(git('ls-files', '-u'), 'Resolver receives the actual conflicting index');
            if (scenario === 'cancel') return undefined;
            const contents = 'main change\ntopic change\n';
            fs.writeFileSync(path.join(root, 'shared.txt'), contents);
            if (scenario === 'edited') fs.appendFileSync(path.join(root, 'shared.txt'), 'later edit\n');
            if (scenario === 'index-changed') {
              fs.writeFileSync(path.join(root, 'unreviewed'), 'keep separate\n');
              git('add', 'unreviewed');
            }
            return { files: [{ path: 'shared.txt', sha256: createHash('sha256').update(contents).digest('hex') }] };
          }
        });
        if (['edited', 'index-changed'].includes(scenario)) {
          await assert.rejects(result, /changed/);
        } else {
          assert.equal(await result, scenario === 'cancel' ? false : 'topic');
        }
        const success = ['clean', 'conflict'].includes(scenario);
        assert.equal(pushed, success ? 1 : 0);
        assert.equal(proposed, scenario === 'clean' ? 0 : 1);
        assert.equal(git('rev-parse', 'main'), main, 'Synchronization never rewrites main');
        assert.equal(git('show', '-s', '--format=%an', before), 'Human Author', 'Existing authors remain intact');
        assert.equal(git('config', 'user.name'), 'Human Author', 'App identity does not change user config');
        if (!success) {
          assert.equal(git('rev-parse', 'HEAD'), before, 'Cancelled or stale proposals cannot create a commit');
          continue;
        }
        assert.equal(git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce'),
          'lindsey-fixture[bot]\x00123+lindsey-fixture[bot]@users.noreply.github.com\x00lindsey-fixture[bot]\x00123+lindsey-fixture[bot]@users.noreply.github.com');
        assert.equal(git('rev-parse', 'HEAD^'), before);
        assert.equal(git('status', '--porcelain'), '');
        assert.equal(git('show', '-s', '--format=%P').split(' ').length, strategy === 'merge' ? 2 : 1);
        assert(!git('log', '-1', '--format=%B').includes('Co-authored-by:'), 'Routine automation invents no assistant credits');
        if (scenario === 'conflict') {
          assert.match(git('log', '-1', '--format=%B'), /Resolve conflicts/);
          assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'main change\ntopic change\n');
          assert(!fs.existsSync(path.join(root, '.git', 'sweetiebot-sync-reports')), 'Resolved conflicts are not reported as an automatic merge');
        }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  }
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
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'main'));
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
