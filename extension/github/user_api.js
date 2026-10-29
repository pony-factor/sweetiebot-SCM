'use strict';
const { githubResponseError } = require('./rate_limit');
function githubUserAPI(token, fetchImpl = globalThis.fetch, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  return async (endpoint, { method = 'GET', body } = {}) => {
    if (!/^(?:repos\/[\w.-]+\/[\w.-]+(?:$|\/)|user$)/.test(endpoint)) throw Error('Invalid GitHub user API endpoint.');
    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetchImpl('https://api.github.com/' + endpoint, { method, headers: {
          Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (error) {
        const transient = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code || error.cause?.code)
          || error instanceof TypeError && /fetch failed|network|load failed/i.test(error.message);
        if (method !== 'GET' || attempt >= 2 || !transient || error.rateLimited) throw error;
        await sleep(attempt ? 1500 : 500);
        continue;
      }
      if (method !== 'GET' || attempt >= 2 || ![502, 503, 504].includes(response.status)) break;
      const retry = response.headers?.get?.('retry-after');
      const requested = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now()) : 0;
      if (requested > 30000) break; // Respect a longer server pause without polling.
      await response.body?.cancel?.();
      await sleep(Math.max(attempt ? 1500 : 500, Number.isFinite(requested) ? requested : 0));
    }
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
