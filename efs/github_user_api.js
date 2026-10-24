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
function legacyAPI(request) {
  return (endpoint, method = 'GET', fields = []) => {
    const body = {};
    for (let index = 0; index < fields.length; index += 2) {
      if (fields[index] !== '-f' || typeof fields[index + 1] !== 'string' || !fields[index + 1].includes('=')) throw Error('Invalid GitHub API field.');
      const split = fields[index + 1].indexOf('=');
      body[fields[index + 1].slice(0, split)] = fields[index + 1].slice(split + 1);
    }
    return request(endpoint, { method, ...(method === 'GET' ? {} : { body }) });
  };
}
module.exports = { githubUserAPI, legacyAPI };
