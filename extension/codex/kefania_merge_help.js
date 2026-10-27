'use strict';

const { githubSession } = require('../github/session');
const { githubGet, startMergeDashboard } = require('../merge/dashboard');

const SHA = /^[a-f0-9]{40}$/i;

// Reuse Lindsey's full, live single-PR dashboard and its action dispatcher.
// No recovery action is performed merely by opening the dashboard.
async function openKefaniaMergeHelp(vscode, context, rootUri, repository, published, {
  session = githubSession, getPR = githubGet, start = startMergeDashboard
} = {}) {
  const url = 'https://github.com/' + repository + '/pull/' + published?.number;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !Number.isSafeInteger(published?.number) || published.number < 1 ||
      published.url !== url || !published.head || !published.base) {
    throw new Error('Published pull-request identity is unavailable.');
  }
  const auth = await session(vscode);
  const pr = await getPR(globalThis.fetch, auth.accessToken, repository, '/pulls/' + published.number);
  if (pr.number !== published.number || pr.html_url !== url || pr.state !== 'open' || pr.merged_at ||
      pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      pr.head?.ref !== published.head || pr.base?.ref !== published.base ||
      !SHA.test(pr.head.sha)) {
    throw new Error('The pull request changed or closed. Review it on GitHub before starting recovery.');
  }
  start(vscode, { repository, pullRequests: [{
    number: pr.number, title: pr.title, url,
    head: pr.head.ref, base: pr.base.ref, headSha: pr.head.sha
  }] }, auth.accessToken, { context, rootUri });
  return true;
}

module.exports = { openKefaniaMergeHelp };
