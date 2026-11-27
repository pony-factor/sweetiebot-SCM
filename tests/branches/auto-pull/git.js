'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { autoPullClean, autoPullDefaultWorktree } = require('../../../extension/branches/actions');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-auto-pull-'));
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}
async function run() {
  const origin = path.join(directory, 'origin.git'), upstream = path.join(directory, 'upstream.git');
  const local = path.join(directory, 'local'), other = path.join(directory, 'other');
  git(directory, 'init', '--bare', '--initial-branch=main', origin);
  git(directory, 'init', '--bare', '--initial-branch=main', upstream);
  git(directory, 'clone', origin, local);
  git(local, 'config', 'user.name', 'Test'); git(local, 'config', 'user.email', 'test@example.invalid');
  git(local, 'config', 'core.hooksPath', '/dev/null');
  for (const name of ['note.txt', 'staged.txt', 'incoming.txt']) fs.writeFileSync(path.join(local, name), 'base\n');
  git(local, 'add', '.'); git(local, 'commit', '-m', 'Base'); git(local, 'push', '-u', 'origin', 'main');
  git(local, 'remote', 'add', 'upstream', upstream);
  git(local, 'push', 'upstream', 'main');
  git(local, 'config', 'sweetiebot.remote', 'origin');
  git(directory, 'clone', upstream, other);
  git(other, 'config', 'user.name', 'Test'); git(other, 'config', 'user.email', 'test@example.invalid');
  git(other, 'config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(local, 'note.txt'), 'Keep my unstaged note\n');
  fs.writeFileSync(path.join(local, 'staged.txt'), 'Keep my staged note\n'); git(local, 'add', 'staged.txt');
  fs.writeFileSync(path.join(other, 'incoming.txt'), 'Incoming change\n');
  git(other, 'add', 'incoming.txt'); git(other, 'commit', '-m', 'Incoming'); git(other, 'push');
  const repository = {
    rootUri: { fsPath: local }, state: {},
    async status() {
      const [ahead, behind] = git(local, 'rev-list', '--left-right', '--count', 'HEAD...origin/main').split(/\s+/).map(Number);
      this.state.HEAD = { name: git(local, 'branch', '--show-current'), commit: git(local, 'rev-parse', 'HEAD'),
        upstream: { remote: 'origin', name: 'main' }, ahead, behind };
      this.state.mergeChanges = [];
      this.state.indexChanges = [{}]; this.state.workingTreeChanges = [{}];
    },
    async fetch({ remote, ref }) { git(local, 'fetch', remote, ref); }
  };
  const topic = path.join(directory, 'topic');
  git(local, 'worktree', 'add', '-b', 'topic', topic, 'main');
  const topicHead = git(topic, 'rev-parse', 'HEAD');
  const topicRepository = {
    rootUri: { fsPath: topic }, state: { HEAD: { name: 'topic' } },
    async fetch({ remote, ref }) { git(topic, 'fetch', remote, ref); }
  };
  fs.writeFileSync(path.join(topic, 'draft.txt'), 'Pending PR edit\n');
  const pendingJournal = path.join(git(local, 'rev-parse', '--absolute-git-dir'),
    'sweetiebot-async-commit.json');
  fs.writeFileSync(pendingJournal, '{"state":"pending"}', 'utf8');
  const pendingHead = git(local, 'rev-parse', 'HEAD');
  assert.equal(await autoPullClean(repository, { fetch: true }), false,
    'Pending local commit title prevents a direct-Git auto-pull');
  assert.equal(await autoPullDefaultWorktree(topicRepository), false,
    'A topic window respects pending commit titles in its main worktree');
  assert.equal(git(local, 'rev-parse', 'HEAD'), pendingHead);
  fs.unlinkSync(pendingJournal);
  git(local, 'config', 'sweetiebot.pull-remote', 'origin');
  assert.equal(await autoPullClean(repository, { fetch: true }), false,
    'An explicit pull-remote override uses origin even when upstream exists');
  git(local, 'config', '--unset', 'sweetiebot.pull-remote');
  assert.equal(await autoPullDefaultWorktree(topicRepository, new Set([git(local, 'rev-parse', '--show-toplevel')])), false,
    'The regular poller handles main when it is already open');
  assert.equal(await autoPullDefaultWorktree(topicRepository), true,
    'A topic window fast-forwards its separate main worktree from upstream');
  assert.equal(git(topic, 'rev-parse', 'HEAD'), topicHead);
  assert.equal(git(topic, 'branch', '--show-current'), 'topic');
  assert.equal(git(topic, 'status', '--porcelain'), '?? draft.txt');
  assert.equal(git(local, 'config', '--get', 'branch.main.remote'), 'origin',
    'Auto-pull never changes the tracked push remote');
  assert.equal(git(local, 'config', '--get', 'sweetiebot.remote'), 'origin');
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
  assert.notEqual(git(local, 'rev-parse', 'HEAD'), git(local, 'rev-parse', 'origin/main'),
    'Auto-detected upstream advances main even when tracked origin has not moved');
  assert.equal(fs.readFileSync(path.join(local, 'note.txt'), 'utf8'), 'Keep my unstaged note\n');
  assert.equal(git(local, 'show', ':staged.txt'), 'Keep my staged note');
  assert.equal(git(local, 'diff', '--name-only'), 'note.txt');
  assert.equal(git(local, 'diff', '--cached', '--name-only'), 'staged.txt');
  for (const [label, pull] of [
    ['open main window', () => autoPullClean(repository, { fetch: true })],
    ['separate main worktree', () => autoPullDefaultWorktree(topicRepository)]
  ]) {
    const mergedEdit = `Already merged from the ${label}\n`;
    fs.writeFileSync(path.join(local, 'incoming.txt'), mergedEdit);
    fs.writeFileSync(path.join(other, 'incoming.txt'), mergedEdit);
    fs.writeFileSync(path.join(other, 'merged-test.txt'), label);
    git(other, 'add', 'incoming.txt', 'merged-test.txt');
    git(other, 'commit', '-m', `Merge edits from the ${label}`);
    git(other, 'push');
    if (label === 'open main window') {
      const untracked = path.join(local, 'merged-test.txt');
      const oldHead = git(local, 'rev-parse', 'HEAD');
      fs.writeFileSync(untracked, 'Keep my untracked file');
      await assert.rejects(pull(), /overwritten by merge/);
      assert.equal(git(local, 'rev-parse', 'HEAD'), oldHead);
      assert.equal(fs.readFileSync(untracked, 'utf8'), 'Keep my untracked file');
      assert.equal(fs.readFileSync(path.join(local, 'incoming.txt'), 'utf8'), mergedEdit,
        'A failed retry restores the already-merged edit');
      fs.unlinkSync(untracked);
    }
    assert.equal(await pull(), true);
    assert.equal(git(local, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
    assert.equal(fs.readFileSync(path.join(local, 'incoming.txt'), 'utf8'), mergedEdit);
    assert.equal(fs.readFileSync(path.join(local, 'merged-test.txt'), 'utf8'), label);
    assert.equal(git(local, 'diff', '--name-only'), 'note.txt');
    assert.equal(git(local, 'diff', '--cached', '--name-only'), 'staged.txt');
  }
  const before = git(local, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(other, 'note.txt'), 'Overlapping incoming change\n');
  git(other, 'add', 'note.txt'); git(other, 'commit', '-m', 'Overlap'); git(other, 'push');
  await assert.rejects(autoPullDefaultWorktree(topicRepository), /overwritten by merge/);
  await assert.rejects(autoPullClean(repository, { fetch: true }), /overwritten by merge/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(local, 'note.txt'), 'utf8'), 'Keep my unstaged note\n');
  assert.equal(git(local, 'diff', '--cached', '--name-only'), 'staged.txt');
  console.log('Automatic fast-forward absorbs identical merged edits and preserves unrelated or conflicting changes.');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
