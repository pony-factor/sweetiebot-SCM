'use strict';

const assert = require('node:assert/strict');
const {
  MIB,
  GITHUB_FILE_MAX_BYTES,
  SPLIT_PART_BYTES,
  evaluateCommitLimits,
  createDiffMetricsScanner,
  scanDiffMetrics,
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

{
  // Chunk boundaries may split a Git header or a UTF-8 character. Count raw
  // bytes, total lines, and per-file metrics without accumulating the diff.
  const rawDiff = Buffer.from(
    'diff --git a/one b/one\n+🤖\ndiff --git a/two b/two\n+no final newline'
  );
  const expected = scanDiffMetrics(rawDiff);
  assert.equal(expected.sections.length, 2);
  assert.equal(expected.totalBytes, rawDiff.length);
  assert.deepEqual(expected.sections.map(section => section.lines), [2, 2]);
  for (const chunkSize of [1, 2, 3, 7, 16, 1024]) {
    const scanner = createDiffMetricsScanner();
    for (let offset = 0; offset < rawDiff.length; offset += chunkSize) {
      scanner.write(rawDiff.subarray(offset, offset + chunkSize));
    }
    assert.deepEqual(scanner.finish(), expected, `chunk size ${chunkSize}`);
  }
  const contentMarker = scanDiffMetrics(Buffer.from(
    'diff --git a/one b/one\n+diff --git a/fake b/fake\n'
  ));
  assert.equal(contentMarker.sections.length, 1, 'added content is not a Git header');
  assert.deepEqual(scanDiffMetrics(Buffer.alloc(0)), {
    totalBytes: 0, totalLines: 0, sections: []
  });
}
{
  // Two individually acceptable sections can exceed the aggregate 1 MB limit
  // without tripping either per-file limit.
  const individual = 'diff --git a/a b/a\n' + '+x'.repeat(210_000) + '\n';
  const rawDiff = Buffer.from(individual + individual + individual);
  const metrics = scanDiffMetrics(rawDiff);
  const status = evaluateCommitLimits({
    files: ['a', 'b', 'c'],
    blobs: [],
    diffMetrics: metrics
  });
  assert(status.warnings.some(value => value.includes('1 MB')));
  assert(!status.warnings.some(value => value.includes('500 KB')));
  assert(!status.warnings.some(value => value.includes('per-file')));
  assert.deepEqual(
    evaluateCommitLimits({ files: ['a', 'b', 'c'], blobs: [], rawDiff }).warnings,
    status.warnings,
    'buffered callers and streaming callers should get identical warnings'
  );
}
{
  const rawDiff = Buffer.from('diff --git a/big b/big\n' + 'x'.repeat(500_001));
  const status = evaluateCommitLimits({ files: ['big'], blobs: [], diffMetrics: scanDiffMetrics(rawDiff) });
  assert(status.warnings.some(value => value.includes('500 KB per-file')));
  const manyLines = Buffer.from('diff --git a/many b/many\n' + '+x\n'.repeat(20_001));
  const lineStatus = evaluateCommitLimits({
    files: ['many'], blobs: [], diffMetrics: scanDiffMetrics(manyLines)
  });
  assert(lineStatus.warnings.some(value => value.includes('20,000-line per-file')));
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
    // Changing the staged tree in a warning prompt invalidates the inspected
    // snapshot. Re-inspect the new tree rather than rejecting it immediately.
    fs.writeFileSync(path.join(repo, 'large.txt'), 'many lines\n'.repeat(21_000));
    cp.execFileSync('git', ['add', 'large.txt'], { cwd: repo });
    let prompts = 0;
    vscode.window.showWarningMessage = async message => {
      warnings.push(message);
      if (++prompts === 1) {
        fs.writeFileSync(path.join(repo, 'late.txt'), 'changed after approval\n');
        cp.execFileSync('git', ['add', 'late.txt'], { cwd: repo });
      }
      return 'Commit anyway';
    };
    const revalidated = await inspect(uri, { captureTree: true });
    const newTree = cp.execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.deepEqual(revalidated, { approved: true, stagedTree: newTree });
    assert.equal(prompts, 2, 'staging changes cause a fresh inspection and warning');

    // Reusing this exact approved tree must not rerun or reprompt the costly
    // diff/size inspection. A new staged tree invalidates this cache.
    vscode.window.showWarningMessage = async message => {
      warnings.push(message);
      return undefined;  // Decline any newly required warnings.
    };
    assert.equal(await inspect(uri, { approvedTree: newTree }), true,
      'reuse the one approved diff inspection while the Git tree is unchanged');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'another change\n');
    cp.execFileSync('git', ['add', 'other.txt'], { cwd: repo });
    assert.equal(await inspect(uri, { approvedTree: newTree }), false,
      'a changed tree must run a new inspection and honor canceled warnings');

    // A rapidly changing staged tree must not trap the commit action in an
    // unlimited validation loop or approve an unstable selection.
    let churn = 0;
    vscode.window.showWarningMessage = async message => {
      warnings.push(message);
      if (/GitHub may warn/.test(message)) {
        churn++;
        fs.writeFileSync(path.join(repo, 'churn-' + churn + '.txt'), 'new staged data\n');
        cp.execFileSync('git', ['add', 'churn-' + churn + '.txt'], { cwd: repo });
        return 'Commit anyway';
      }
      return undefined;
    };
    const unstable = await inspect(uri, { captureTree: true });
    assert.equal(unstable.approved, false);
    assert.equal(churn, 3, 'only three inspection attempts are allowed for a changing index');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log('Commit limit tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
