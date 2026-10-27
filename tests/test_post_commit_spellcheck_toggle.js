'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {postCommitSpellcheck} = require('../extension/commits/post_commit_spellcheck_notice');

test('post-commit spellcheck toolbar reads and persists the same global Git opt-in', async () => {
  let value;
  const calls = [];
  const git = async (_cwd, args) => {
    calls.push(args);
    if (args.includes('--get')) {
      if (value === undefined) throw Object.assign(new Error('unset'), {code: 1});
      return String(value);
    }
    value = args.at(-1) === 'true';
    return '';
  };
  assert.equal(await postCommitSpellcheck('get', git), false);
  assert.equal(await postCommitSpellcheck('toggle', git), true);
  assert.equal(await postCommitSpellcheck('get', git), true);
  assert.equal(await postCommitSpellcheck('toggle', git), false);
  assert.deepEqual(calls.filter(args => !args.includes('--get')), [
    ['config', '--global', 'scm-toolkit.post-commit-spellcheck', 'true'],
    ['config', '--global', 'scm-toolkit.post-commit-spellcheck', 'false']
  ]);
});
test('post-commit spellcheck toolbar does not mask Git config errors', async () => {
  await assert.rejects(
    postCommitSpellcheck('get', async () => { throw Object.assign(new Error('permission denied'), {code: 128}); }),
    /permission denied/
  );
});
