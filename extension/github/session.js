"use strict";
// Prefer the account already selected by GitHub Pull Requests. Silent lookups
// reuse granted scopes and never ask for broader permissions.
async function githubSession(vscode) {
  const existing = await vscode.authentication.getSession('github', [], { silent: true });
  if (existing?.scopes?.includes('repo')) return existing;
  if (existing?.account) {
    for (const scopes of [['read:user', 'user:email', 'repo'], ['read:user', 'user:email', 'repo', 'workflow'], ['repo']]) {
      const session = await vscode.authentication.getSession('github', scopes, { silent: true, account: existing.account });
      if (session) return session;
    }
  }
  return vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
}
module.exports = { githubSession };
