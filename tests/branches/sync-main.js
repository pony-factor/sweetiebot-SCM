'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { refreshMain, syncIdentity, syncPublisher } = require('../../extension/branches/sync-main');
const { syncBranch } = require('../../extension/branches/actions');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-refresh-main-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  try {
    const remote = path.join(directory, 'source.git');
    const source = path.join(directory, 'source');
    const root = path.join(directory, 'topic');
    const main = path.join(directory, 'main');
    git(directory, 'init', '--bare', '--initial-branch=main', remote);
    git(directory, 'clone', remote, source);
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'user.email', 'test@example.invalid');
    git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Base');
    git(source, 'push', 'origin', 'main');
    git(directory, 'clone', remote, root);
    git(root, 'remote', 'add', 'upstream', remote);
    git(root, 'switch', '-c', 'topic');
    git(root, 'worktree', 'add', main, 'main');
    const before = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(source, 'incoming'), 'upstream work\n');
    git(source, 'add', 'incoming');
    git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Incoming');
    git(source, 'push', 'origin', 'main');
    const tip = git(source, 'rev-parse', 'HEAD');
    const fetches = [];
    const repository = { rootUri: { fsPath: root }, async fetch({ remote, ref }) {
      fetches.push(remote); git(root, 'fetch', remote, ref);
    } };
    const options = { defaultBranch: 'main', remote: 'upstream', checkBranch: async () => {
      assert.equal(git(root, 'branch', '--show-current'), 'topic');
    } };
    fs.writeFileSync(path.join(main, 'draft'), 'preserve');
    await assert.rejects(refreshMain(repository, options), /local changes/);
    assert.equal(git(main, 'rev-parse', 'HEAD'), before);
    fs.unlinkSync(path.join(main, 'draft'));
    assert.equal(await refreshMain(repository, options), 'refs/heads/main');
    assert.equal(git(main, 'rev-parse', 'HEAD'), tip);
    assert.equal(git(root, 'rev-parse', 'HEAD'), before);
    assert(fetches.every(remote => remote === 'upstream'));
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    repository.state = { HEAD: { name: 'topic' }, mergeChanges: [] };
    repository.inputBox = { value: 'Preserved draft' };
    repository.status = async () => {
      repository.state.HEAD = { name: git(root, 'branch', '--show-current') };
      repository.state.mergeChanges = [];
    };
    assert.equal(await syncBranch(repository, { branch: 'topic', defaultBranch: 'main', remote: 'origin' }), 'topic');
    assert.equal(fetches.at(-1), 'upstream', 'Button prefers upstream while origin remains the publishing remote');
    assert.equal(fs.readFileSync(path.join(root, 'incoming'), 'utf8'), 'upstream work\n');
    assert.equal(repository.inputBox.value, 'Preserved draft');
    const topicTip = git(root, 'rev-parse', 'HEAD');
    git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Local main');
    git(source, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Divergent incoming');
    git(source, 'push', 'origin', 'main');
    await assert.rejects(refreshMain(repository, options), /diverged/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), topicTip);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }

  const bot = { name: 'fixture-lindsey[bot]', email: '123+fixture-lindsey[bot]@users.noreply.github.com' };
  const fetchImpl = async url => {
    assert.equal(url, 'https://api.github.com/users/fixture-lindsey%5Bbot%5D');
    return { ok: true, json: async () => ({ login: bot.name, id: 123, type: 'Bot' }) };
  };
  assert.deepEqual(await syncIdentity({ login: bot.name, fetchImpl }), bot);
  await assert.rejects(syncIdentity({ login: bot.name,
    fetchImpl: async () => ({ ok: true, json: async () => ({ login: 'someone', id: 123, type: 'User' }) }) }), /verify/);
  let writes = 0, tokens = 0, commits = 0;
  const publish = await syncPublisher('/fixture', 'origin', {
    enabled: () => true,
    identity: async () => bot,
    transport: repo => {
      assert.equal(repo, 'owner/fork');
      return { async gitToken() { tokens++; return 'fixture-token'; } };
    },
    run: async (command, args, options) => {
      assert.equal(command, 'git');
      if (args[0] === 'remote') return { stdout: 'git@github.com:owner/fork.git\n' };
      if (args[0] === 'commit') {
        commits++;
        assert.equal(options.env.GIT_AUTHOR_NAME, bot.name);
        assert.equal(options.env.GIT_AUTHOR_EMAIL, bot.email);
        assert.equal(options.env.GIT_COMMITTER_NAME, bot.name);
        assert.equal(options.env.GIT_COMMITTER_EMAIL, bot.email);
        assert(!args.includes('--no-gpg-sign'));
        return { stdout: '' };
      }
      writes++;
      assert(args.includes('https://github.com/owner/fork.git'));
      assert(args.includes('abc:refs/heads/topic'));
      assert(!args.some(value => value.includes('fixture-token') || value.includes('--force')));
      assert.equal(options.env.GH_TOKEN, 'fixture-token');
      return { stdout: '' };
    }
  });
  assert.equal(tokens, 1, 'App credentials are checked before committing');
  await publish.commit('🔄 Sync branch to main');
  assert.equal(commits, 1);
  await publish('topic', 'abc');
  assert.equal(writes, 1);
  assert.equal(tokens, 2, 'Publication refreshes credentials');
  assert.equal(await syncPublisher('/fixture', 'origin', { enabled: () => false }), null);
  await assert.rejects(syncPublisher('/fixture', 'origin', {
    enabled: () => true, run: async () => ({ stdout: 'https://example.com/repo.git' })
  }), /GitHub publishing remote/);
  console.log('Shared main refresh, divergence guards and Lindsey publication passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
