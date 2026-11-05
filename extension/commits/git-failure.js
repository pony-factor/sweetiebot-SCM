'use strict';

// Git stderr can contain a patch, remote credentials, or arbitrary filenames.
// Return only fixed classifications and the command verb, never raw output.
function safeGitFailure(error, args) {
  const verbs = new Set(['clone', 'fetch', 'rev-parse', 'merge-base', 'diff', 'ls-tree',
    'checkout', 'merge', 'read-tree', 'status', 'apply', 'add', 'write-tree', 'commit-tree',
    'commit', 'push', 'ls-remote', 'config', 'update-index', 'check-ref-format']);
  const verb = args.find(value => verbs.has(value));
  const status = Number.isInteger(error?.code) ? ' (exit ' + error.code + ')' : '';
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  let reason = '';
  if (/patch failed|patch does not apply|corrupt patch|patch fragment without header|unrecognized input/i.test(stderr)) {
    reason = ' The resolution patch did not apply to the current tree.';
  } else if (/gpg failed|failed to sign|signing failed|cannot run gpg/i.test(stderr)) {
    reason = ' Commit signing failed.';
  } else if (/authentication failed|permission denied|could not read username|repository not found/i.test(stderr)) {
    reason = ' Git authentication or repository access failed.';
  } else if (/could not resolve host|failed to connect|connection timed out/i.test(stderr)) {
    reason = ' Git could not reach the remote.';
  } else if (/non-fast-forward|fetch first|stale info|cannot lock ref/i.test(stderr)) {
    reason = ' A Git reference changed; refresh the selected head and base.';
  } else if (/nothing to commit|nothing added to commit/i.test(stderr)) {
    reason = ' The integration has no new staged changes.';
  } else if (error?.code === 'ENOENT') {
    reason = ' The Git executable is unavailable.';
  } else if (error?.killed || error?.code === 'ETIMEDOUT') {
    reason = ' The operation timed out.';
  }
  return 'Local Git' + (verb ? ' ' + verb : ' operation') + ' failed' + status + '.' + reason +
    ' No file contents or credentials are included in this report.';
}

function gitFailure(error, args) {
  const failure = Error(safeGitFailure(error, args));
  if (args.includes('apply') && /patch failed|patch does not apply|corrupt patch|patch fragment without header|unrecognized input/i.test(String(error?.stderr || ''))) {
    failure.code = 'INVALID_RESOLUTION_PATCH';
  }
  return failure;
}

module.exports = { safeGitFailure, gitFailure };
