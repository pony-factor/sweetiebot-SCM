'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { publishPonyProfile } = require('../efs/pony_git_publish');

const pony = { packId: 'g4-mares', canonicalSlug: 'berry-punch', slug: 'berry-punch' };
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

async function fixture(run) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-pony-push-'));
  const root = path.join(sandbox, 'kefania');
  const remote = path.join(sandbox, 'remote.git');
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
    execFileSync('git', ['init', '--initial-branch=main', root]);
    git(root, 'config', 'user.name', 'Tester');
    git(root, 'config', 'user.email', 'tester@example.test');
    await fs.writeFile(path.join(root, 'README.md'), 'Kafania\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'Seed');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '--set-upstream', 'origin', 'main');
    await fs.mkdir(path.join(root, 'ponies', 'g4-mares'), { recursive: true });
    await fs.writeFile(path.join(root, 'ponies', 'g4-mares', 'berry-punch.json'), '{"profile":"Sourced"}\n');
    await run(root, remote);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

(async () => {
  await fixture(async (root, remote) => {
    // Unrelated user staging, unstaged edits, and untracked files are untouched.
    await fs.writeFile(path.join(root, 'README.md'), 'Unrelated staged edit\n');
    git(root, 'add', 'README.md');
    await fs.writeFile(path.join(root, 'scratch.txt'), 'do not commit\n');
    const initial = git(root, 'rev-parse', 'HEAD');
    const result = await publishPonyProfile(root, pony, 'g4-mares/berry-punch.json');
    assert.equal(result.pushed, true);
    assert.equal(result.path, 'ponies/g4-mares/berry-punch.json');
    assert.notEqual(result.commit, initial);
    assert.equal(git(root, 'show', '--format=', '--name-only', 'HEAD'), result.path);
    assert.match(git(root, 'log', '-1', '--format=%B'), /^🦄 Add pony profile: g4-mares\/berry-punch\n/);
    assert.match(git(root, 'log', '-1', '--format=%B'), /Co-authored-by: Codex Web <noreply@openai.com>/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), git(root, 'rev-parse', 'refs/remotes/origin/main'));
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), result.commit);
    assert.equal(git(root, 'status', '--porcelain=1', '--', 'README.md'), 'M  README.md');
    assert.equal(git(root, 'status', '--porcelain=1', '--', 'scratch.txt'), '?? scratch.txt');
    await assert.rejects(publishPonyProfile(root, pony, 'g4-mares/berry-punch.json'), /not a new/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), result.commit, 'No duplicate or empty commit');
  });

  await fixture(async root => {
    const original = git(root, 'rev-parse', 'HEAD');
    await assert.rejects(publishPonyProfile(root, pony, '../README.md'), /unexpected pony profile path/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), original);
    git(root, 'checkout', '-b', 'topic');
    await assert.rejects(publishPonyProfile(root, pony, 'g4-mares/berry-punch.json'), /main tracking origin\/main/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), original);
  });

  await fixture(async root => {
    await fs.writeFile(path.join(root, 'other.txt'), 'not yet pushed\n');
    git(root, 'add', 'other.txt');
    git(root, 'commit', '-m', 'Unpushed work');
    const original = git(root, 'rev-parse', 'HEAD');
    await assert.rejects(publishPonyProfile(root, pony, 'g4-mares/berry-punch.json'), /not synchronized/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), original);
    assert.equal(git(root, 'status', '--porcelain=1', '--', 'ponies/g4-mares/berry-punch.json'),
      '?? ponies/g4-mares/berry-punch.json');
  });
  console.log('Kafania pony-only automatic commit and push safeguards passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
