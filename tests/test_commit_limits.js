'use strict';

const assert = require('node:assert/strict');
const {
  MIB,
  GITHUB_FILE_MAX_BYTES,
  evaluateCommitLimits,
  confirmCommitLimits
} = require('../efs/commit_limits');

{
  const status = evaluateCommitLimits({
    files: ['huge.bin'],
    blobs: [{ path: 'huge.bin', size: GITHUB_FILE_MAX_BYTES + 1 }],
    rawDiff: Buffer.from('diff --git a/huge.bin b/huge.bin\n')
  });
  assert.equal(status.hardErrors.length, 1);
  assert.match(status.hardErrors[0], /100 MiB/);
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
  assert.equal(await confirmCommitLimits(vscode, { hardErrors: [], warnings: ['too large'] }), true);
  assert.equal(calls[0][2], 'Commit anyway');
  vscode.window.showWarningMessage = async () => undefined;
  assert.equal(await confirmCommitLimits(vscode, { hardErrors: [], warnings: ['too large'] }), false);
  console.log('Commit limit tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
