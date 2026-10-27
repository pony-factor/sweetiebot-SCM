'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-app-settings-test-'));
try {
  const config = path.join(directory, 'public.gitconfig');
  fs.writeFileSync(config, '[scm-toolkit]\n' +
    'github-app-identity-mode = separate-apps\n' +
    'kefania-app-id = 1234\nkefania-app-slug = kefania-test\nkefania-app-keychain = true\n' +
    'lindsey-app-id = 5678\nlindsey-app-slug = lindsey-test\nlindsey-app-keychain = true\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of Object.keys(env)) {
    if (name.startsWith('SWEETIEBOT_') || name.startsWith('GIT_CONFIG_KEY_') ||
        name.startsWith('GIT_CONFIG_VALUE_') || name === 'GIT_CONFIG_COUNT') delete env[name];
  }
  const settings = require.resolve('../extension/github/github_app_settings');
  const identity = require.resolve('../extension/github/github_app_identity');
  const program = `
    const assert = require('node:assert/strict');
    const {savedEnvironment} = require(process.argv[1]);
    const {separateAppsEnabled, roleSettings, workflowBotLogin} = require(process.argv[2]);
    assert.equal(separateAppsEnabled(), true);
    assert.equal(workflowBotLogin('kefania'), 'kefania-test[bot]');
    assert.equal(workflowBotLogin('lindsey'), 'lindsey-test[bot]');
    assert.equal(roleSettings('kefania').keychain, true);
    assert.equal(roleSettings('kefania').id, '1234');
    process.env.SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY = 'environment-key';
    assert.equal(roleSettings('kefania').inlineKey, 'environment-key');
    assert.equal(roleSettings('kefania').keychain, false);
    process.env.SWEETIEBOT_BOT_IDENTITY_MODE = 'legacy';
    assert.equal(separateAppsEnabled(), false);
    const custom = {};
    assert.equal(savedEnvironment(custom), custom);
    assert.equal(separateAppsEnabled(custom), false);
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', program, settings, identity],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
