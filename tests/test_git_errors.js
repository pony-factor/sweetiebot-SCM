'use strict';

const assert = require('node:assert/strict');
const { formatGitError, explainGitError } = require('../efs/branch_actions');

function run() {
  const cases = [
    [
      { message: 'Failed to execute git', stderr: 'error: Your local changes would be overwritten by merge' },
      /local changes would be overwritten/i
    ],
    [
      { message: 'Failed to execute git', stderr: 'fatal: Unable to create .git/index.lock: File exists. Another git process seems to be running' },
      /locked by another Git process/i
    ],
    [
      { gitErrorCode: 'Conflict', message: 'Git error', stderr: 'CONFLICT (content): Merge conflict in README.md' },
      /unresolved merge conflicts/i
    ],
    [
      { message: 'Failed to execute git', stderr: 'remote: Repository not found.\nfatal: Authentication failed' },
      /could not authenticate with the remote/i
    ],
    [
      { message: 'Failed to execute git', stderr: '! [rejected] topic -> topic (non-fast-forward)' },
      /remote branch has newer commits/i
    ]
  ];

  for (const [error, expected] of cases) {
    const message = formatGitError(error);
    assert.match(message, expected);
    assert(!message.includes('⛓️‍💥'));
  }

  const raw = formatGitError({
    message: 'Failed to execute git',
    stderr: 'fatal: unable to access remote: TLS handshake failed'
  });
  assert.match(raw, /unable to access remote: TLS handshake failed/);
  assert(!raw.includes('Failed to execute git'));

  const plain = new Error('No branch was supplied for publishing.');
  assert.equal(explainGitError(plain), plain);

  const wrapped = explainGitError({
    message: 'Failed to execute git',
    stderr: 'fatal: not a git repository'
  });
  assert.match(wrapped.message, /not a Git repository/);
  assert(!wrapped.message.includes('⛓️‍💥'));
  assert.equal(explainGitError(Object.assign(wrapped, { gitErrorCode: 'Conflict' })), wrapped);
}

run();
