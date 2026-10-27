'use strict';
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { separateAppsEnabled, roleSettings, workflowBotLogin, stripAppSecrets,
  getRoleInstallationToken } = require('../extension/github/github_app_identity');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } });
const env = {
  SWEETIEBOT_BOT_IDENTITY_MODE: 'separate-apps',
  SWEETIEBOT_KEFANIA_APP_ID: '1234', SWEETIEBOT_KEFANIA_APP_SLUG: 'kefania-pony',
  SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY: privateKey,
  SWEETIEBOT_LINDSEY_APP_ID: '5678', SWEETIEBOT_LINDSEY_APP_SLUG: 'lindsey-pony',
  SWEETIEBOT_LINDSEY_APP_PRIVATE_KEY: privateKey
};
const now = () => Date.parse('2026-10-22T12:00:00Z');
function mockGitHub(role, { wrongSlug = false, missingInstall = false, expired = false } = {}) {
  const requests = [];
  const id = role === 'kefania' ? 1234 : 5678;
  const slug = role === 'kefania' ? 'kefania-pony' : 'lindsey-pony';
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/app')) return { ok: true, json: async () =>
      ({ id, slug: wrongSlug ? 'codex-pony' : slug }) };
    if (url.endsWith('/installation')) return missingInstall
      ? { ok: false, status: 404 } : { ok: true, json: async () => ({ id: 90 }) };
    if (url.endsWith('/access_tokens')) return { ok: true, json: async () => ({
      token: role + '-install-token', expires_at: expired
        ? '2026-10-22T12:00:30Z' : '2026-10-22T12:59:00Z'
    }) };
    throw new Error('Unexpected request: ' + url);
  };
  return { fetchImpl, requests };
}
async function run() {
  assert.equal(separateAppsEnabled({}), false);
  assert.equal(workflowBotLogin('kefania', {}), 'codex-pony[bot]');
  assert.equal(workflowBotLogin('kefania', env), 'kefania-pony[bot]');
  assert.equal(workflowBotLogin('lindsey', env), 'lindsey-pony[bot]');
  assert.equal(roleSettings('kefania', env).id, '1234');
  assert.throws(() => separateAppsEnabled({ SWEETIEBOT_BOT_IDENTITY_MODE: 'typo' }), /must be/);
  assert.throws(() => roleSettings('linsey', env), /Unknown/);
  assert.throws(() => roleSettings('kefania', { ...env,
    SWEETIEBOT_KEFANIA_APP_SLUG: 'codex-pony', SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY_FILE: '/a' }), /exactly one/);
  const scrubbed = stripAppSecrets({ ...env, GH_TOKEN: 'user-session' });
  assert.equal(scrubbed.SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY, undefined);
  assert.equal(scrubbed.SWEETIEBOT_LINDSEY_APP_PRIVATE_KEY, undefined);
  assert.equal(scrubbed.GH_TOKEN, 'user-session');
  for (const role of ['kefania', 'lindsey']) {
    const fake = mockGitHub(role);
    const result = await getRoleInstallationToken(role, 'pony-factor/sweetiebot-SCM',
      { env, now, fetchImpl: fake.fetchImpl });
    assert.equal(result.login, role + '-pony[bot]');
    assert.equal(result.token, role + '-install-token');
    assert.deepEqual(fake.requests.map(item => item.url.split('api.github.com')[1]), [
      '/app', '/repos/pony-factor/sweetiebot-SCM/installation', '/app/installations/90/access_tokens'
    ]);
    const payload = JSON.parse(fake.requests[2].init.body);
    assert.deepEqual(payload.repositories, ['sweetiebot-SCM']);
    assert.equal(payload.permissions.contents, role === 'lindsey' ? 'write' : 'read');
    assert.equal(payload.permissions.pull_requests, 'write');
    assert.equal(payload.permissions.issues, 'write');
    assert(!JSON.stringify(fake.requests).includes(privateKey));
    const header = fake.requests[0].init.headers.Authorization;
    assert.equal(header.split('.').length, 3, 'App JWT is signed');
  }
  const readOnly = mockGitHub('lindsey');
  await getRoleInstallationToken('lindsey', 'pony-factor/sweetiebot-SCM',
    { env, now, readOnly: true, fetchImpl: readOnly.fetchImpl });
  assert.deepEqual(JSON.parse(readOnly.requests[2].init.body).permissions,
    { contents: 'read', pull_requests: 'read', issues: 'read',
      checks: 'read', statuses: 'read' });
  const keychainEnv = { ...env, SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY: undefined,
    SWEETIEBOT_KEFANIA_APP_KEYCHAIN: 'true' };
  let retrievedRole;
  const keychainResult = await getRoleInstallationToken('kefania', 'pony-factor/sweetiebot-SCM', {
    env: keychainEnv, now, fetchImpl: mockGitHub('kefania').fetchImpl,
    keychainKey: async role => { retrievedRole = role; return privateKey; },
    readKey: () => { throw new Error('Keychain mode must not read a key file'); }
  });
  assert.equal(retrievedRole, 'kefania');
  assert.equal(keychainResult.login, 'kefania-pony[bot]');
  await assert.rejects(getRoleInstallationToken('kefania', 'pony-factor/sweetiebot-SCM', {
    env: keychainEnv, now, keychainKey: async () => { throw new Error('Keychain locked'); }
  }), /Keychain locked/);
  await assert.rejects(getRoleInstallationToken('kefania', 'pony-factor/sweetiebot-SCM',
    { env, now, fetchImpl: mockGitHub('kefania', {wrongSlug: true}).fetchImpl }), /different GitHub App/);
  await assert.rejects(getRoleInstallationToken('kefania', 'pony-factor/sweetiebot-SCM',
    { env, now, fetchImpl: mockGitHub('kefania', {missingInstall: true}).fetchImpl }), /HTTP 404/);
  await assert.rejects(getRoleInstallationToken('lindsey', 'pony-factor/sweetiebot-SCM',
    { env, now, fetchImpl: mockGitHub('lindsey', {expired: true}).fetchImpl }), /unexpired/);
  await assert.rejects(getRoleInstallationToken('kefania', '../danger',
    { env, now, fetchImpl: mockGitHub('kefania').fetchImpl }), /Invalid GitHub repository/);
  await assert.rejects(getRoleInstallationToken('kefania', 'pony-factor/sweetiebot-SCM',
    { env: { ...env, SWEETIEBOT_KEFANIA_APP_ID: undefined }, now,
      fetchImpl: mockGitHub('kefania').fetchImpl }), /Configure/);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
