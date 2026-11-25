'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { createLindseyResolverIdentity } = require('../github/app-identity');

function resolverEndpoint(override, webhook) {
  let url;
  try { url = new URL(override || webhook); } catch { /* Use a sanitized error below. */ }
  if (!url || url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (override && url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.pathname !== (override ? '/resolve-conflicts' : '/webhook')) {
    throw Error('Lindsey needs an HTTPS /webhook URL on its GitHub App or an explicit /resolve-conflicts URL.');
  }
  url.pathname = '/resolve-conflicts';
  return url;
}

async function connectLindseyResolver(repository, { env = process.env, fetchImpl = globalThis.fetch,
  identity = createLindseyResolverIdentity, now = Date.now } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw Error('Lindsey needs a GitHub repository to resolve conflicts.');
  const { appId, webhook, sign } = await identity({ env, fetchImpl, now });
  const endpoint = resolverEndpoint(env.LINDSEY_RESOLVE_URL, webhook);
  const send = async (method, body = '') => {
    const time = String(Math.floor(now() / 1000));
    const nonce = randomUUID();
    const digest = createHash('sha256').update(body).digest('hex');
    const proof = sign(['lindsey-resolver-v1', method, appId, repository, time, nonce, digest].join('\n'));
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(method === 'GET' ? 20000 : 120000),
        headers: { 'X-Lindsey-App': appId, 'X-Lindsey-Repository': repository, 'X-Lindsey-Time': time,
          'X-Lindsey-Nonce': nonce, 'X-Lindsey-Proof': proof,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body } : {})
      });
    } catch { throw Error('Could not reach the Lindsey resolver configured for the GitHub App.'); }
    if (response.status === 401 || response.status === 403) {
      throw Error('The Lindsey resolver could not verify this App key or repository installation.');
    }
    if (!response.ok) throw Error('The Lindsey resolver request failed (HTTP ' + response.status + '). Check that the resolver supports App authentication.');
    let result;
    try { result = await response.json(); } catch { /* Invalid response. */ }
    if (!result?.ok || (method === 'GET' && result.authentication !== 'lindsey-app-v1')) {
      throw Error('The Lindsey resolver returned an unexpected response. Check the resolver deployment.');
    }
    return result;
  };
  await send('GET');
  return request => send('POST', JSON.stringify(request));
}

module.exports = { connectLindseyResolver };
