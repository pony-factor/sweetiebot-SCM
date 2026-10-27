'use strict';

// Deliberately opt-in: an installation token changes GitHub's *actual* actor,
// whereas changing a Git author, co-author trailer or display name does not.
const { createSign } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { savedEnvironment, readKeychainKey } = require('./app_settings');

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const SLUG = /^[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/;
const ROLES = new Set(['kefania', 'lindsey']);
const API = 'https://api.github.com';

function separateAppsEnabled(env = process.env) {
  env = savedEnvironment(env);
  const mode = env.SWEETIEBOT_BOT_IDENTITY_MODE || 'legacy';
  if (mode !== 'legacy' && mode !== 'separate-apps') {
    throw new Error('SWEETIEBOT_BOT_IDENTITY_MODE must be legacy or separate-apps.');
  }
  return mode === 'separate-apps';
}

function roleSettings(role, env = process.env) {
  env = savedEnvironment(env);
  if (!ROLES.has(role)) throw new Error('Unknown GitHub App workflow role.');
  const prefix = 'SWEETIEBOT_' + role.toUpperCase() + '_APP_';
  const id = String(env[prefix + 'ID'] || '');
  const slug = String(env[prefix + 'SLUG'] || '').toLowerCase();
  const inlineKey = env[prefix + 'PRIVATE_KEY'];
  const keyFile = env[prefix + 'PRIVATE_KEY_FILE'];
  const keychain = env[prefix + 'KEYCHAIN'] === 'true';
  if (!/^\d+$/.test(id) || !SLUG.test(slug) ||
      [inlineKey, keyFile, keychain].filter(Boolean).length !== 1) {
    throw new Error('Configure ' + prefix + 'ID, ' + prefix + 'SLUG and exactly one of ' +
      prefix + 'PRIVATE_KEY or ' + prefix + 'PRIVATE_KEY_FILE, or save a key in Magic Settings.');
  }
  return { id, slug, inlineKey, keyFile, keychain };
}

function workflowBotLogin(role, env = process.env) {
  if (!separateAppsEnabled(env)) return 'codex-pony[bot]';
  return roleSettings(role, env).slug + '[bot]';
}

function stripAppSecrets(env = process.env) {
  const copy = { ...env };
  for (const role of ROLES) {
    const prefix = 'SWEETIEBOT_' + role.toUpperCase() + '_APP_';
    delete copy[prefix + 'PRIVATE_KEY'];
    delete copy[prefix + 'PRIVATE_KEY_FILE'];
  }
  return copy;
}

function signAppJwt(appId, key, now) {
  const seconds = Math.floor(now / 1000);
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' +
    encode({ iat: seconds - 60, exp: seconds + 540, iss: appId });
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return unsigned + '.' + signer.sign(key).toString('base64url');
  } catch {
    throw new Error('The configured GitHub App private key is invalid.');
  }
}

async function getRoleInstallationToken(role, repository, {
  env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
  readKey = readFile, keychainKey = readKeychainKey, readOnly = false
} = {}) {
  if (!separateAppsEnabled(env)) throw new Error('Distinct GitHub App mode is not enabled.');
  if (!REPOSITORY.test(repository || '')) throw new Error('Invalid GitHub repository for GitHub App authorization.');
  const config = roleSettings(role, env);
  const key = config.keychain ? await keychainKey(role) : config.keyFile
    ? await readKey(config.keyFile, 'utf8') : config.inlineKey.replace(/\\n/g, '\n');
  const jwt = signAppJwt(config.id, key, now());
  const request = async (endpoint, authorization, method = 'GET', body) => {
    let response;
    try {
      response = await fetchImpl(API + endpoint, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + authorization,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'sweetiebot-app-identities',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000)
      });
    } catch {
      throw new Error('Could not contact GitHub to authenticate ' + role + ' as an App.');
    }
    if (!response?.ok) {
      // Never include GitHub's response body: it may contain sensitive details.
      throw new Error('GitHub App ' + role + ' request failed (HTTP ' + response?.status + '). Check installation and permissions.');
    }
    try { return await response.json(); }
    catch { throw new Error('GitHub returned invalid GitHub App authentication data.'); }
  };
  const app = await request('/app', jwt);
  if (String(app?.id) !== config.id || app?.slug?.toLowerCase() !== config.slug) {
    throw new Error('The configured ' + role + ' credentials identify a different GitHub App.');
  }
  const installation = await request('/repos/' + repository + '/installation', jwt);
  if (!Number.isSafeInteger(installation?.id) || installation?.suspended_at) {
    throw new Error('The ' + role + ' GitHub App must have an active repository installation.');
  }
  // Scope each one-hour token to the selected repository, never an org-wide token.
  const permissions = readOnly
    ? { contents: 'read', pull_requests: 'read', issues: 'read',
      checks: 'read', statuses: 'read' }
    : { contents: role === 'lindsey' ? 'write' : 'read',
      pull_requests: 'write', issues: 'write' };
  const authorized = await request('/app/installations/' + installation.id + '/access_tokens',
    jwt, 'POST', { repositories: [repository.split('/')[1]], permissions });
  if (typeof authorized?.token !== 'string' || !authorized.token ||
      Date.parse(authorized.expires_at) <= now() + 60000 ||
      !Number.isFinite(Date.parse(authorized.expires_at))) {
    throw new Error('GitHub did not return a usable, unexpired installation token for ' + role + '.');
  }
  return { token: authorized.token, login: config.slug + '[bot]', expiresAt: authorized.expires_at };
}

module.exports = { separateAppsEnabled, roleSettings, workflowBotLogin,
  stripAppSecrets, getRoleInstallationToken };
