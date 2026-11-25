'use strict';

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, verify } = require('node:crypto');
const { connectLindseyResolver } = require('../../extension/merge/lindsey-resolver-auth');

async function run() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { SWEETIEBOT_LINDSEY_APP_ID: '42', SWEETIEBOT_LINDSEY_APP_SLUG: 'lindsey',
    SWEETIEBOT_LINDSEY_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push(String(url));
    assert.equal(options.redirect, 'error');
    if (String(url) === 'https://api.github.com/app/hook/config') {
      assert.match(options.headers.Authorization, /^Bearer .*\..*\..*$/);
      return Response.json({ url: 'https://lindsey.example.invalid/webhook' });
    }
    const h = options.headers;
    assert.equal(h.Authorization, undefined);
    assert.equal(h['X-Lindsey-Repository'], 'owner/repo');
    const digest = createHash('sha256').update(options.body ?? '').digest('hex');
    const message = ['lindsey-resolver-v1', options.method, '42', 'owner/repo', h['X-Lindsey-Time'],
      h['X-Lindsey-Nonce'], digest].join('\n');
    assert(verify('RSA-SHA256', Buffer.from(message), publicKey, Buffer.from(h['X-Lindsey-Proof'], 'base64url')));
    return options.method === 'GET' ? Response.json({ ok: true, authentication: 'lindsey-app-v1' })
      : Response.json({ ok: true, resolutions: [] });
  };
  const resolve = await connectLindseyResolver('owner/repo', { env, fetchImpl });
  assert.equal(requested.length, 2, 'The preflight sends no conflict body');
  await resolve({ files: [{ path: 'fixture.txt' }] });
  assert.deepEqual(requested, ['https://api.github.com/app/hook/config',
    'https://lindsey.example.invalid/resolve-conflicts', 'https://lindsey.example.invalid/resolve-conflicts']);
  await assert.rejects(connectLindseyResolver('owner/repo', { env, fetchImpl: async url =>
    String(url).startsWith('https://api.github.com/') ? Response.json({ url: 'https://lindsey.example.invalid/webhook' })
      : new Response('', { status: 401 }) }), /could not verify this App key/);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
