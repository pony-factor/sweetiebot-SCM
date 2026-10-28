'use strict';
const { githubSession } = require('../github/session');
const { githubResponseError, promptRateLimit } = require('../github/rate_limit');
const { publishBlockerReport } = require('./blocker_report');

// Repair previously published grouped analysis using the signed-in VS Code
// account. Existing review/comment ownership and exact PR snapshots are checked
// again by the publisher before it writes anything.
async function repairMergeReview(vscode) {
  const url = await vscode.window.showInputBox({ prompt: 'Pull request whose grouped merge review needs updated analysis', placeHolder: 'https://github.com/owner/repo/pull/123' });
  if (url === undefined) return;
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.trim());
  if (!match) throw Error('Enter a GitHub pull-request URL.');
  const [, repository, number] = match;
  const session = await githubSession(vscode);
  const api = async (endpoint, { method = 'GET', body } = {}) => {
    const response = await fetch('https://api.github.com/' + endpoint, { method, headers: {
      Authorization: 'Bearer ' + session.accessToken, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw await githubResponseError(response, 'GitHub review request failed (HTTP ' + response.status + ').');
    return response.status === 204 ? null : response.json();
  };
  try {
    const prefix = 'repos/' + repository + '/pulls/' + number;
    const info = await api(prefix);
    const actor = await api('user');
    const comments = [];
    for (let page = 1; page <= 20; page++) {
      const chunk = await api(prefix + '/comments?per_page=100&page=' + page);
      comments.push(...chunk); if (chunk.length < 100) break;
      if (page === 20) throw Error('Review history is incomplete.');
    }
    const decisions = comments.filter(note => note.user?.login === actor.login && note.body?.startsWith('<!-- sweetiebot-merge-analysis -->')).map(note => {
      const title = /### ([^\n]+)/.exec(note.body)?.[1];
      const description = note.body.split(/### [^\n]+\n\n/)[1]?.split('\n\n👍')[0]?.trim();
      return { path: note.path, title, description };
    });
    const result = await publishBlockerReport({ repository, pr: { number: Number(number), title: info.title, head: info.head.ref, headSha: info.head.sha, base: info.base.ref }, paths: decisions.map(note => note.path), decisions, api });
    if (!result.posted) throw Object.assign(Error(result.error || 'No owned per-file analysis was found.'), result.rateLimited ? { rateLimited: true, retryAt: result.retryAt } : {});
    vscode.window.showInformationMessage('Grouped review updated; compatible integrations need no reaction.');
    return result;
  } catch (error) { if (!await promptRateLimit(vscode, error)) throw error; }
}
module.exports = { repairMergeReview };
