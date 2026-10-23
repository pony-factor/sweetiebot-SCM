'use strict';

const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const SERVICE = 'com.sweetiebot.github-apps';

function setting(name) {
  try {
    return execFileSync('git', ['config', '--global', '--get', 'scm-toolkit.' + name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch { return ''; }
}

// Explicit environment configuration remains supported. Tests supplying their
// own environment never consult the user's machine configuration.
function savedEnvironment(env) {
  if (env !== process.env) return env;
  const resolved = { ...env };
  resolved.SWEETIEBOT_BOT_IDENTITY_MODE ||= setting('github-app-identity-mode') || 'legacy';
  for (const role of ['kefania', 'lindsey']) {
    const prefix = 'SWEETIEBOT_' + role.toUpperCase() + '_APP_';
    resolved[prefix + 'ID'] ||= setting(role + '-app-id');
    resolved[prefix + 'SLUG'] ||= setting(role + '-app-slug');
    if (!resolved[prefix + 'PRIVATE_KEY'] && !resolved[prefix + 'PRIVATE_KEY_FILE'] &&
        setting(role + '-app-keychain') === 'true') resolved[prefix + 'KEYCHAIN'] = 'true';
  }
  return resolved;
}

async function readKeychainKey(role) {
  if (process.platform !== 'darwin') throw new Error('GitHub App Keychain storage requires macOS.');
  try {
    const { stdout } = await exec('/usr/bin/security',
      ['find-generic-password', '-s', SERVICE, '-a', role, '-w'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    return stdout.trim();
  } catch {
    // exec errors may contain stdout; never expose them to the UI or logs.
    throw new Error('Could not unlock the ' + role + ' App key in macOS Keychain.');
  }
}

module.exports = { savedEnvironment, readKeychainKey };
