'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveDefaultBranch } = require('../../extension/branches/actions');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-default-'));
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 }).trim();
}
async function check(defaultName) {
  const remote = path.join(root, defaultName + '.git');
  const work = path.join(root, defaultName);
  git(root, 'init', '--bare', '--initial-branch=' + defaultName, remote);
  git(root, 'clone', remote, work);
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Tester');
  fs.writeFileSync(path.join(work, 'sample.txt'), defaultName + '\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'Test');
  git(work, 'push', '-u', 'origin', defaultName);
  git(work, 'checkout', '-b', 'main');
  git(work, 'push', 'origin', 'main');
  git(work, 'checkout', '-b', 'topic');
  git(work, 'remote', 'set-head', 'origin', defaultName);
  const repo = { rootUri: { fsPath: work } };
  assert.equal(await resolveDefaultBranch(repo), defaultName,
    'Use actual remote HEAD even when main also exists');
  git(work, 'config', '--local', 'sweetiebot.default-branch', 'custom');
  assert.equal(await resolveDefaultBranch({ rootUri: { fsPath: work } }), 'custom',
    'Repository-local override takes precedence');
  git(work, 'config', '--local', '--unset-all', 'sweetiebot.default-branch');
  git(work, 'config', '--local', 'scm-toolkit.default-branch', 'legacy-custom');
  assert.equal(await resolveDefaultBranch({ rootUri: { fsPath: work } }), 'legacy-custom',
    'Older repository overrides remain effective after global migration');
  git(work, 'config', '--local', 'sweetiebot.default-branch', 'canonical-custom');
  assert.equal(await resolveDefaultBranch({ rootUri: { fsPath: work } }), 'canonical-custom',
    'Canonical local overrides win when both names exist');
}
(async () => {
  try {
    for (const branch of ['main', 'master', 'notes']) {
      const work = path.join(root, 'local-' + branch);
      git(root, 'init', '--initial-branch=' + branch, work);
      const repo = { rootUri: { fsPath: work } };
      assert.equal(await resolveDefaultBranch(repo), branch,
        'A local repository can resolve its unborn branch before its first commit');
      git(work, 'config', 'user.email', 'test@example.invalid');
      git(work, 'config', 'user.name', 'Tester');
      fs.writeFileSync(path.join(work, 'sample.txt'), 'Local files\n');
      git(work, 'add', 'sample.txt');
      git(work, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Test');
      assert.equal(await resolveDefaultBranch({ rootUri: { fsPath: work } }), branch);
      if (branch === 'main') {
        git(work, 'checkout', '-b', 'topic');
        assert.equal(await resolveDefaultBranch({ rootUri: { fsPath: work } }), 'main',
          'Keep an existing local main as the base when checking out a topic');
      }
      git(work, 'remote', 'add', 'origin', path.join(root, 'missing-remote.git'));
      if (branch !== 'main') {
        await assert.rejects(resolveDefaultBranch({ rootUri: { fsPath: work } }),
          /Could not determine/, 'Do not guess the base of a configured remote');
      }
    }
    await check('master');
    await check('develop');
    console.log('Default branch resolution tests passed for local, unborn, and remote repositories.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
