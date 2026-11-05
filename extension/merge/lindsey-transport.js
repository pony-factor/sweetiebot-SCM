'use strict';

const { separateAppsEnabled, getRoleInstallationToken } = require('../github/app-identity');
const { createLindseyReadFetch } = require('../github/read-api');
const { githubUserAPI, legacyAPI } = require('../github/user-api');

// Keep original Git authorship while making Lindsey the actual authenticated
// actor for pushes and merge writes. Never fall back to the user's credential.
function createLindseyTransport(repository, { env = process.env, fetchImpl = globalThis.fetch,
  getToken = getRoleInstallationToken, now = Date.now } = {}) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw Error('Invalid Lindsey repository.');
  const prefix = 'repos/' + repository;
  let credential, pending;
  const getGitToken = async () => {
    if (!separateAppsEnabled(env)) throw Error('Enable and configure the Lindsey GitHub App for local handoffs.');
    if (credential && Date.parse(credential.expiresAt) > now() + 120000) return credential.token;
    pending ||= Promise.resolve().then(() => getToken('lindsey', repository, {env, fetchImpl, now}))
      .then(value => {
        if (!value?.token || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now() + 120000)
          throw Error('Lindsey installation token expires too soon.');
        credential = value;
        return value.token;
      }).finally(() => { pending = undefined; });
    return pending;
  };
  const read = githubUserAPI('unused', createLindseyReadFetch(repository, {env, fetchImpl, getToken, now}));
  const api = legacyAPI(async (endpoint, options = {}) => {
    if (!separateAppsEnabled(env)) throw Error('Enable and configure the Lindsey GitHub App for local handoffs.');
    if ((endpoint !== prefix && !endpoint.startsWith(prefix + '/')) || /%(?:2f|5c|2e)/i.test(endpoint)
        || endpoint.split('?')[0].split('/').some(part => part === '..' || part === '.'))
      throw Error('Lindsey handoff request is outside the selected repository.');
    if ((options.method || 'GET') === 'GET') return read(endpoint, options);
    return githubUserAPI(await getGitToken(), fetchImpl)(endpoint, options);
  });
  return { api, gitToken: getGitToken };
}

module.exports = { createLindseyTransport };
