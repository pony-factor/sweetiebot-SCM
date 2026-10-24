'use strict';
const { githubResponseError } = require('./github_rate_limit');
function githubUserAPI(token, fetchImpl = globalThis.fetch) {
  return async (endpoint, { method = 'GET', body } = {}) => {
    if (!/^(?:repos\/[\w.-]+\/[\w.-]+\/|user$)/.test(endpoint)) throw Error('Invalid GitHub user API endpoint.');
    const response = await fetchImpl('https://api.github.com/' + endpoint, { method, headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw await githubResponseError(response, 'GitHub user request failed (HTTP ' + response.status + ').');
    return response.status === 204 ? null : response.json();
  };
}
module.exports = { githubUserAPI };
