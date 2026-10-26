'use strict';

const assert = require('node:assert/strict');
const { formatGitError, explainGitError, isBlockedByLocalChanges, offerBlockedChangesOptions } = require('../efs/branches/branch_actions');

async function run() {
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
    assert(!message.includes('Git could not complete the operation'));
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

  assert.equal(isBlockedByLocalChanges({
    stderr: 'error: Your local changes to the following files would be overwritten by checkout:'
  }), true);
  assert.equal(isBlockedByLocalChanges(new Error('Commit or stash your changes before squashing the default branch.')), true);
  assert.equal(isBlockedByLocalChanges(new Error('CONFLICT (content): README.md')), false);

  const calls = [];
  let selection = 'review';
  const vscode = {
    window: {
      async showQuickPick(items) { return items.find(item => item.id === selection); },
      showInformationMessage(message) { calls.push(['info', message]); }
    },
    commands: {
      async executeCommand(id) { calls.push(['command', id]); }
    }
  };
  const repository = {
    state: { HEAD: { name: 'topic' }, mergeChanges: [] },
    async status() { calls.push(['status']); }
  };
  const retry = async () => { calls.push(['retry']); return 'topic'; };
  const stash = async () => { calls.push(['stash']); return 'abcde12345'; };
  assert.equal(await offerBlockedChangesOptions(vscode, repository, 'sweetiebot.returnHome', retry, stash), undefined);
  assert.deepEqual(calls.splice(0), [['command', 'workbench.view.scm']]);
  selection = 'commit';
  assert.equal(await offerBlockedChangesOptions(vscode, repository, 'sweetiebot.returnHome', retry, stash), undefined);
  assert.deepEqual(calls.splice(0), [['command', 'workbench.view.scm']]);
  selection = 'output';
  assert.equal(await offerBlockedChangesOptions(vscode, repository, 'sweetiebot.returnHome', retry, stash), undefined);
  assert.deepEqual(calls.splice(0), [['command', 'git.showOutput']]);
  selection = 'cancel';
  assert.equal(await offerBlockedChangesOptions(vscode, repository, 'sweetiebot.returnHome', retry, stash), undefined);
  assert.deepEqual(calls.splice(0), []);
  selection = 'stash';
  assert.equal(await offerBlockedChangesOptions(vscode, repository, 'sweetiebot.returnHome', retry, stash), 'topic');
  assert.deepEqual(calls.map(call => call[0]), ['status', 'stash', 'info', 'retry']);
  assert.match(calls.find(call => call[0] === 'info')[1], /git stash pop --index/);
  calls.length = 0;
  repository.status = async () => { repository.state.HEAD.name = 'other'; };
  await assert.rejects(
    offerBlockedChangesOptions(vscode, repository, 'sweetiebot.returnHome', retry, stash),
    /active branch changed/i
  );
  assert.equal(calls.length, 0, 'Never stash after switching branches');

}
run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
