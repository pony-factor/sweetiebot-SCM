'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveDefaultBranch } = require('../efs/branch_actions');

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
  git(work, 'config', '--local', 'scm-toolkit.default-branch', 'custom');
  assert.equal(await resolveDefaultBranch({ rootUri: { fsPath: work } }), 'custom',
    'Repository-local override takes precedence');
}
(async () => {
  try {
    await check('master');
    await check('develop');
    console.log('Default branch resolution tests passed for master and develop.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
