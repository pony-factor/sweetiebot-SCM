'use strict';

const { separateAppsEnabled, workflowBotLogin } = require('./app-identity');

// Keep the verified GitHub App login separate from the requested Git commit
// identity. A commit identity change cannot rename the authenticated App actor.
const LINDSEY_COMMIT_IDENTITY = Object.freeze({
  name: 'Lindsey Pony', email: '346700433+sync@users.noreply.github.com'
});
async function appCommitIdentity({ login = workflowBotLogin('lindsey'), token,
  fetchImpl = globalThis.fetch } = {}) {
  let account, failure = 'GitHub returned an invalid bot account';
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetchImpl('https://api.github.com/users/' + encodeURIComponent(login), {
      headers, signal: AbortSignal.timeout(15000)
    });
    if (response.ok) account = await response.json();
    else failure = response.status === 429 || response.headers?.get('x-ratelimit-remaining') === '0'
      ? 'GitHub rate limit reached; retry after the limit resets'
      : 'GitHub account lookup failed' + (Number.isInteger(response.status) ? ' (HTTP ' + response.status + ')' : '');
  } catch { failure = 'GitHub account lookup could not complete; check the connection and retry'; }
  if (!account || account.login?.toLowerCase() !== login.toLowerCase()
      || account.type !== 'Bot' || !Number.isSafeInteger(account.id) || account.id <= 0) {
    throw Error('Could not verify the configured Lindsey bot identity. ' + failure + '. No automation commit was created.');
  }
  return { ...LINDSEY_COMMIT_IDENTITY, login: account.login };
}

async function configuredMergeActor(repository, { enabled = separateAppsEnabled,
  transport = require('../merge/lindsey-transport').createLindseyTransport,
  identity = appCommitIdentity } = {}) {
  if (!enabled()) return null;
  const actor = transport(repository);
  const token = await actor.gitToken(); // Verify App access before any commit or publication.
  const { login, name, email } = await identity({ token });
  if (!login || !/\[bot\]$/i.test(login)) throw Error('Could not verify the Lindsey App login.');
  return { ...actor, login, author: { name, email } };
}

// Both roles are explicit: inherited author configuration must not attribute
// generated edits to the user's account. Keep signing configuration untouched.
function commitIdentityArgs(author, committer = author) {
  for (const identity of [author, committer]) {
    if (!identity || typeof identity.name !== 'string' || !identity.name.trim()
        || /[<>\r\n\0]/.test(identity.name)
        || typeof identity.email !== 'string' || !/^[^\s<>]+@[^\s<>]+$/.test(identity.email)) {
      throw Error('Invalid Git commit identity.');
    }
  }
  return ['-c', 'user.name=' + author.name, '-c', 'user.email=' + author.email,
    '-c', 'author.name=' + author.name, '-c', 'author.email=' + author.email,
    '-c', 'committer.name=' + committer.name, '-c', 'committer.email=' + committer.email];
}

module.exports = { appCommitIdentity, configuredMergeActor, commitIdentityArgs };
