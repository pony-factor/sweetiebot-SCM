'use strict';
const assert = require('node:assert/strict');
const { kefaniaChildEnvironment } = require('../efs/codex/kefania_runner');

async function run() {
  const legacy = await kefaniaChildEnvironment('pony-factor/example', {
    botOnly: true, env: { PATH: '/bin', GH_TOKEN: 'personal-token' }
  });
  assert.equal(legacy.KEFANIA_GITHUB_AUTH, 'app');
  assert.equal(legacy.GH_TOKEN, 'personal-token');

  const directLegacy = await kefaniaChildEnvironment('pony-factor/example',
    { env: { PATH: '/bin' } });
  assert.equal(directLegacy.KEFANIA_GITHUB_AUTH, undefined);

  const env = {
    PATH: '/bin', GH_TOKEN: 'personal-token',
    KEFANIA_GITHUB_APP_ID: 'old-id',
    KEFANIA_GITHUB_PRIVATE_KEY: 'old-key',
    KEFANIA_GITHUB_INSTALLATION_ID: 'old-installation',
    SWEETIEBOT_BOT_IDENTITY_MODE: 'separate-apps',
    SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY: 'sensitive-key',
    SWEETIEBOT_LINDSEY_APP_PRIVATE_KEY: 'other-sensitive-key'
  };
  let calls = 0;
  const child = await kefaniaChildEnvironment('pony-factor/example', {
    botOnly: true, env, async roleToken(role, repository, options) {
      calls++;
      assert.equal(role, 'kefania');
      assert.equal(repository, 'pony-factor/example');
      assert.equal(options.env, env);
      return { token: 'kefania-installation-token' };
    }
  });
  assert.equal(calls, 1);
  assert.equal(child.KEFANIA_GITHUB_AUTH, 'cli');
  assert.equal(child.GH_TOKEN, 'kefania-installation-token');
  assert.equal(child.GITHUB_TOKEN, 'kefania-installation-token');
  assert.equal(child.KEFANIA_GITHUB_PRIVATE_KEY, undefined);
  assert.equal(child.KEFANIA_GITHUB_APP_ID, undefined);
  assert.equal(child.KEFANIA_GITHUB_INSTALLATION_ID, undefined);
  assert.equal(child.SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY, undefined);
  assert.equal(child.SWEETIEBOT_LINDSEY_APP_PRIVATE_KEY, undefined);
  assert.equal(env.GH_TOKEN, 'personal-token', 'Never change the parent environment');
  await assert.rejects(kefaniaChildEnvironment('pony-factor/example', {
    botOnly: true, env, async roleToken() { throw Error('App not installed'); }
  }), /App not installed/, 'A failed App preflight must not fall back to the user');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
