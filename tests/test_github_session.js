'use strict';
const assert = require('node:assert/strict');
const { githubSession } = require('../efs/github_session');
(async () => {
  const calls = [], existing = { account: { id: 'signed-in-user', label: 'User' }, scopes: ['repo', 'read:user', 'user:email'], accessToken: 'test-session' };
  const vscode = { authentication: { getSession: async (...args) => { calls.push(args); return existing; } } };
  assert.equal(await githubSession(vscode), existing);
  assert.equal(calls.length, 1, 'Reuse the existing repo-capable VS Code session without new permissions');
  existing.scopes = ['read:user'];
  vscode.authentication.getSession = async (...args) => {
    calls.push(args);
    if (!args[1].length) return existing;
    assert.equal(args[2].silent, true);
    assert.equal(args[2].account, existing.account, 'Never switch accounts when looking for existing repo permissions');
    return { ...existing, scopes: args[1] };
  };
  const reused = await githubSession(vscode);
  assert(reused.scopes.includes('repo'));
  assert(!calls.some(args => args[2].createIfNone), 'Existing sidebar login does not create another session');
  console.log('VS Code GitHub session reuse and account affinity passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
