'use strict';

const assert = require('node:assert/strict');
const {
  MIB,
  GITHUB_FILE_MAX_BYTES,
  SPLIT_PART_BYTES,
  evaluateCommitLimits,
  splitPartPaths,
  splitOversizedFile,
  confirmCommitLimits,
  registerCommitLimitCommand
} = require('../efs/commit_limits');

{
  const status = evaluateCommitLimits({
    files: ['huge.bin'],
    blobs: [{ path: 'huge.bin', size: GITHUB_FILE_MAX_BYTES + 1 }],
    rawDiff: Buffer.from('diff --git a/huge.bin b/huge.bin\n')
  });
  assert.equal(status.hardErrors.length, 1);
  assert.equal(status.oversized.length, 1);
  assert.match(status.hardErrors[0], /100 MiB/);
}
{
  const parts = splitPartPaths('archive.bin', 150 * MIB);
  assert.deepEqual(parts, ['archive.bin.part001', 'archive.bin.part002']);
  assert.equal(SPLIT_PART_BYTES, 95 * MIB);
}
{
  const status = evaluateCommitLimits({
    files: ['large.bin'],
    blobs: [{ path: 'large.bin', size: 51 * MIB }],
    rawDiff: Buffer.from('diff --git a/large.bin b/large.bin\n')
  });
  assert(status.warnings.some(value => value.includes('50 MiB')));
}
{
  const files = Array.from({ length: 301 }, (_, index) => `file-${index}.txt`);
  const rawDiff = Buffer.from('diff --git a/a b/a\n' + 'x\n'.repeat(20_001));
  const status = evaluateCommitLimits({
    files,
    blobs: files.map(file => ({ path: file, size: 1 })),
    rawDiff
  });
  assert(status.warnings.some(value => value.includes('20,000')));
  assert(status.warnings.some(value => value.includes('300')));
}
(async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cp = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-split-'));
  cp.execFileSync('git', ['init', '--quiet'], { cwd: temp });
  cp.execFileSync('git', ['config', 'user.name', 'Sweetiebot Test'], { cwd: temp });
  cp.execFileSync('git', ['config', 'user.email', 'sweetiebot@example.test'], { cwd: temp });
  const source = path.join(temp, 'large.bin');
  fs.writeFileSync(source, Buffer.alloc(3 * MIB, 7));
  cp.execFileSync('git', ['add', 'large.bin'], { cwd: temp });
  const created = await splitOversizedFile(
    temp,
    { path: 'large.bin', size: 3 * MIB },
    2 * MIB
  );
  assert.deepEqual(created, ['large.bin.part001', 'large.bin.part002']);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.statSync(path.join(temp, created[0])).size, 2 * MIB);
  assert.equal(fs.statSync(path.join(temp, created[1])).size, 1 * MIB);
  assert.match(
    cp.execFileSync('git', ['diff', '--cached', '--name-status'], { cwd: temp, encoding: 'utf8' }),
    /large\.bin\.part001/
  );
  fs.rmSync(temp, { recursive: true, force: true });

  const calls = [];
  const vscode = {
    window: {
      showWarningMessage: async (...args) => {
        calls.push(args);
        return 'Commit anyway';
      },
      showErrorMessage: async () => undefined
    },
    env: { openExternal: async () => {} },
    Uri: { parse: value => value }
  };
  assert.equal(await confirmCommitLimits(vscode, '/tmp/repo', { hardErrors: [], warnings: ['too large'], oversized: [] }), true);
  assert.equal(calls[0][2], 'Commit anyway');
  vscode.window.showWarningMessage = async () => undefined;
  assert.equal(await confirmCommitLimits(vscode, '/tmp/repo', { hardErrors: [], warnings: ['too large'], oversized: [] }), false);
  // A background job gets an exact approved-tree identifier, while ordinary
  // direct Git callers continue using the original boolean command result.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-preflight-'));
  try {
    cp.execFileSync('git', ['init', '--quiet'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'code.js'), 'console.log("hello");\n');
    cp.execFileSync('git', ['add', 'code.js'], { cwd: repo });
    const handlers = new Map(), warnings = [];
    const vscode = {
      Uri: { from: uri => uri },
      commands: { registerCommand(id, handler) {
        handlers.set(id, handler);
        return { dispose() {} };
      } },
      window: {
        async showErrorMessage() { return undefined; },
        async showWarningMessage(message) { warnings.push(message); return 'Commit anyway'; }
      }
    };
    registerCommitLimitCommand(vscode, { subscriptions: [] });
    const inspect = handlers.get('sweetiebot.checkCommitLimits');
    const uri = { scheme: 'file', fsPath: repo };
    const approved = await inspect(uri, { captureTree: true });
    const tree = cp.execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.deepEqual(approved, { approved: true, stagedTree: tree });
    assert.equal(await inspect(uri), true, 'normal direct commits retain the boolean API');
    assert.deepEqual(warnings, []);
    // The user can stage changes while reading a nonmodal GitHub diff warning.
    // Do not approve an index different from the one that was inspected.
    fs.writeFileSync(path.join(repo, 'large.txt'), 'many lines\n'.repeat(21_000));
    cp.execFileSync('git', ['add', 'large.txt'], { cwd: repo });
    vscode.window.showWarningMessage = async message => {
      warnings.push(message);
      fs.writeFileSync(path.join(repo, 'late.txt'), 'changed after approval\n');
      cp.execFileSync('git', ['add', 'late.txt'], { cwd: repo });
      return 'Commit anyway';
    };
    const invalidated = await inspect(uri, { captureTree: true });
    assert.equal(invalidated.approved, false,
      'late staging invalidates the snapshot without silently approving extra content');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log('Commit limit tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
