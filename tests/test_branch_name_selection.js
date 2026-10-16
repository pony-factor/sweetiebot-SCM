'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBranchNameHistory, chooseBranchName, saveBranchNameHistory } = require('../efs/branch_name_selection');

async function run() {
  const pool = ['alpha', 'beta', 'gamma'];
  let selected = [];
  for (const expected of pool) {
    const choice = chooseBranchName(pool, selected, max => {
      assert(max >= 1 && max <= pool.length);
      return 0;
    });
    assert.equal(choice.branch, expected);
    selected = choice.selected;
  }
  assert.deepEqual(selected, pool, 'Each available name must be drawn before reuse');
  assert.deepEqual(chooseBranchName(pool, selected, () => 0), { branch: 'alpha', selected: ['alpha'] },
    'A completed cycle starts again with a distinct name');
  assert.equal(chooseBranchName(['gamma', 'alpha'], ['alpha', 'gamma'], () => 0).branch, 'alpha',
    'Names that are available again can be reused after a complete cycle');
  assert.deepEqual(chooseBranchName(['beta'], ['alpha'], () => 0).selected, ['alpha', 'beta'],
    'Names temporarily reserved by existing branches remain in the cycle history');
  assert.equal(chooseBranchName(['solo'], ['solo'], () => 0).branch, 'solo',
    'A one-name pool can be reused');
  assert.equal(chooseBranchName(['alpha', 'beta'], ['alpha'], n => n - 1).branch, 'beta',
    'Injected random integer selects the correct bounded index');
  assert.throws(() => chooseBranchName([], []), /No available/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-name-history-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main');
    const repository = { rootUri: { fsPath: root } };
    const first = await loadBranchNameHistory(repository);
    assert.deepEqual(first.selected, []);
    assert.equal(first.file, path.join(root, '.git', 'sweetiebot-branch-name-history.json'));
    await saveBranchNameHistory(first.file, ['alpha', 'beta']);
    assert.deepEqual((await loadBranchNameHistory(repository)).selected, ['alpha', 'beta'],
      'History survives independent loads');
    assert.equal(git('status', '--porcelain'), '', 'History is never saved in the worktree');

    // Linked worktrees must use the same history, rather than each repeating names.
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git('add', '.');
    git('-c', 'user.name=Sweetiebot Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial');
    const linked = path.join(root, 'linked');
    git('worktree', 'add', '-b', 'linked', linked);
    assert.equal((await loadBranchNameHistory({ rootUri: { fsPath: linked } })).file, first.file);

    fs.writeFileSync(first.file, 'not JSON');
    await assert.rejects(loadBranchNameHistory(repository), /Invalid pony branch history/);
    await saveBranchNameHistory(first.file, []);
    assert.deepEqual((await loadBranchNameHistory(repository)).selected, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Secure pony branch name selection checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
