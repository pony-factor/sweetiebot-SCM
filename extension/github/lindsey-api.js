'use strict';

// Automatic reviews must never borrow the signed-in user's credentials.
async function lindseyAPI(repository, { identity = require('./app-identity'), fetchImpl = globalThis.fetch } = {}) {
  if (!identity.separateAppsEnabled()) throw Error('Configure the Lindsey GitHub App to publish automatic reviews.');
  const { token } = await identity.getRoleInstallationToken('lindsey', repository);
  const login = identity.workflowBotLogin('lindsey');
  return { login, api: async (endpoint, { method = 'GET', body } = {}) => {
    if (!endpoint.startsWith('repos/' + repository + '/')) throw Error('Lindsey review request is outside the selected repository.');
    let response;
    try {
      response = await fetchImpl('https://api.github.com/' + endpoint, {
        method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000)
      });
    } catch { throw Error('Could not contact GitHub to publish the Lindsey review.'); }
    if (!response.ok) throw Error('Lindsey review request failed (HTTP ' + response.status + '). Check App installation and permissions.');
    return response.status === 204 ? null : response.json();
  } };
}
module.exports = { lindseyAPI };
