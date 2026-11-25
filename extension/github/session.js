"use strict";
// Prefer the account already selected by GitHub Pull Requests. Silent lookups
// reuse granted scopes. Background status checks can opt out of sign-in prompts.
async function githubSession(vscode, { interactive = true } = {}) {
  const existing = await vscode.authentication.getSession('github', [], { silent: true });
  if (existing?.scopes?.includes('repo')) return existing;
  if (existing?.account) {
    for (const scopes of [['read:user', 'user:email', 'repo'], ['read:user', 'user:email', 'repo', 'workflow'], ['repo']]) {
      const session = await vscode.authentication.getSession('github', scopes, { silent: true, account: existing.account });
      if (session) return session;
    }
  }
  if (interactive) return vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
}
module.exports = { githubSession };
