'use strict';
const assert = require('node:assert/strict');
const { safeGitFailure, gitFailure } = require('../efs/git_failure');
for (const [stderr, expected] of [
  ['error: corrupt patch at line 9', 'resolution patch did not apply'],
  ['error: gpg failed to sign the data', 'Commit signing failed'],
  ['fatal: Authentication failed', 'authentication or repository access failed'],
  ['fatal: Could not resolve host', 'could not reach the remote'],
  ['rejected: non-fast-forward', 'reference changed'],
  ['nothing to commit', 'no new staged changes']
]) {
  const message = safeGitFailure({ code: 1, stderr: stderr + '\nPRIVATE_FILE_CONTENT\nhttps://user:password@example.test/repo' },
    ['-C', '/private/path', 'apply', '/private/patch']);
  assert(message.includes('Git apply failed (exit 1)'));
  assert(message.includes(expected));
  assert(!/PRIVATE_FILE_CONTENT|password|example\.test|private\/path|private\/patch/.test(message));
}
assert(safeGitFailure({ code: 'ENOENT' }, ['clone']).includes('Git executable is unavailable'));
assert(safeGitFailure({ killed: true }, ['fetch']).includes('timed out'));
assert(!safeGitFailure({ message: 'private error', stderr: 'private stderr' }, ['unknown']).includes('private'));
assert.equal(gitFailure({ stderr: 'corrupt patch' }, ['apply']).code, 'INVALID_RESOLUTION_PATCH');
assert.equal(gitFailure({ stderr: 'gpg failed' }, ['commit']).code, undefined, 'Signing failures cannot be retried as patch syntax');
console.log('Git failure categories retain the operation and suppress arbitrary output, paths and credentials.');
