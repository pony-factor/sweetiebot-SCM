'use strict';
const assert = require('node:assert/strict');
const { createLindseyReadFetch } = require('../efs/github_read_api');
const repo = 'pony-factor/sweetiebot-SCM';
const url = 'https://api.github.com/repos/' + repo + '/pulls/12/files';
const env = { SWEETIEBOT_BOT_IDENTITY_MODE: 'separate-apps' };
(async () => {
  let now = Date.parse('2026-10-24T12:00:00Z');
  const called = [], issued = [];
  const fetchImpl = async (address, options) => {
    called.push({ address, options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const getToken = async (role, repository, options) => {
    issued.push({ role, repository, readOnly: options.readOnly });
    return { token: 'installation-' + issued.length,
      expiresAt: new Date(now + 3600000).toISOString() };
  };
  const readFetch = createLindseyReadFetch(repo, { env, fetchImpl, getToken, now: () => now });
  await Promise.all([readFetch(url, { headers: { Authorization: 'Bearer user-token' } }), readFetch(url)]);
  assert.equal(issued.length, 1);
  assert.deepEqual(issued[0], { role: 'lindsey', repository: repo, readOnly: true });
  assert(called.every(call => call.options.headers.Authorization === 'Bearer installation-1'));
  for (const [address, options] of [[url, {method:'POST'}],
    ['https://evil.example/repos/' + repo, {}], ['https://api.github.com/user', {}],
    ['https://api.github.com/repos/other/repo/pulls/12', {}]]) {
    await assert.rejects(readFetch(address, options), /restricted/);
  }
  now += 59 * 60000;
  await readFetch(url);
  assert.equal(issued.length, 2, 'Expiring tokens are refreshed');
  const legacy = createLindseyReadFetch(repo, {
    env: { SWEETIEBOT_BOT_IDENTITY_MODE: 'legacy' }, fetchImpl,
    getToken: () => { throw Error('Legacy must not mint App tokens'); }
  });
  await legacy(url, { headers: { Authorization: 'Bearer signed-in-user' } });
  assert.equal(called.at(-1).options.headers.Authorization, 'Bearer signed-in-user');
  const broken = createLindseyReadFetch(repo, {
    env, fetchImpl, getToken: async () => { throw Error('Missing installation'); }
  });
  await assert.rejects(broken(url), /Missing installation/);
  assert.equal(called.length, 4, 'App failure never silently borrows the user quota');
})().catch(error => { console.error(error); process.exitCode = 1; });
