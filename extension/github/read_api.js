'use strict';

// App reads are scoped to a single repository. Never reuse this credential
// for merges, pushes, reactions, identity lookups or other writes.
const { separateAppsEnabled, getRoleInstallationToken } = require('./app_identity');
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
// Share one token-acquisition pipeline for default callers in this extension host.
const sharedReaders = new Map();

function createLindseyReadFetch(repository, {
  env = process.env, fetchImpl = globalThis.fetch,
  getToken = getRoleInstallationToken, now = Date.now
} = {}) {
  if (!REPO.test(repository || '')) throw Error('Invalid GitHub repository for Lindsey reads.');
  if (!separateAppsEnabled(env)) return fetchImpl;
  const share = env === process.env && fetchImpl === globalThis.fetch &&
    getToken === getRoleInstallationToken && now === Date.now;
  if (share && sharedReaders.has(repository)) return sharedReaders.get(repository);
  const prefix = '/repos/' + repository;
  let credential, pending;
  async function installationToken() {
    if (credential && Date.parse(credential.expiresAt) > now() + 120000) return credential.token;
    if (!pending) pending = Promise.resolve().then(() =>
      getToken('lindsey', repository, { env, fetchImpl, now, readOnly: true })).then(value => {
      const expiry = Date.parse(value?.expiresAt || '');
      if (typeof value?.token !== 'string' || !value.token ||
          !Number.isFinite(expiry) || expiry <= now() + 120000) {
        throw Error('Lindsey read token expires too soon.');
      }
      credential = value;
      return value.token;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  const read = async (url, options = {}) => {
    let parsed;
    try { parsed = new URL(url); } catch { throw Error('Invalid Lindsey read URL.'); }
    if ((options.method || 'GET').toUpperCase() !== 'GET' ||
        parsed.origin !== 'https://api.github.com' ||
        (parsed.pathname !== prefix && !parsed.pathname.startsWith(prefix + '/')) ||
        parsed.username || parsed.password || parsed.hash ||
        /%(?:2f|5c|2e)/i.test(parsed.pathname)) {
      throw Error('Lindsey installation credentials are restricted to repository GET requests.');
    }
    const token = await installationToken();
    return fetchImpl(parsed.href, { ...options, method: 'GET',
      headers: { ...options.headers, Authorization: 'Bearer ' + token } });
  };
  if (share) sharedReaders.set(repository, read);
  return read;
}

module.exports = { createLindseyReadFetch };
