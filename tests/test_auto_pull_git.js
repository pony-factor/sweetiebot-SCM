'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { autoPullClean } = require('../efs/branch_actions');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-auto-pull-'));
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}
async function run() {
  const remote = path.join(directory, 'remote.git'), local = path.join(directory, 'local'), other = path.join(directory, 'other');
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'clone', remote, local);
  git(local, 'config', 'user.name', 'Test'); git(local, 'config', 'user.email', 'test@example.invalid');
  git(local, 'config', 'core.hooksPath', '/dev/null');
  for (const name of ['note.txt', 'staged.txt', 'incoming.txt']) fs.writeFileSync(path.join(local, name), 'base\n');
  git(local, 'add', '.'); git(local, 'commit', '-m', 'Base'); git(local, 'push', '-u', 'origin', 'main');
  git(directory, 'clone', remote, other);
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
  assert.equal(await autoPullClean(repository, { fetch: true }), true);
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(path.join(local, 'note.txt'), 'utf8'), 'Keep my unstaged note\n');
  assert.equal(git(local, 'show', ':staged.txt'), 'Keep my staged note');
  assert.equal(git(local, 'diff', '--name-only'), 'note.txt');
  assert.equal(git(local, 'diff', '--cached', '--name-only'), 'staged.txt');
  const before = git(local, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(other, 'note.txt'), 'Overlapping incoming change\n');
  git(other, 'add', 'note.txt'); git(other, 'commit', '-m', 'Overlap'); git(other, 'push');
  await assert.rejects(autoPullClean(repository, { fetch: true }), /overwritten by merge/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), before);
  assert.equal(fs.readFileSync(path.join(local, 'note.txt'), 'utf8'), 'Keep my unstaged note\n');
  assert.equal(git(local, 'diff', '--cached', '--name-only'), 'staged.txt');
  console.log('Automatic fast-forward preserves staged and unstaged edits and refuses overlapping incoming paths.');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
