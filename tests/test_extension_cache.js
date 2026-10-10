'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { userExtensionCachePath, invalidateUserExtensionCache } = require('../efs/extension_cache');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweetiebot-cache-'));
try {
  const cache = path.join(root, 'Code', 'CachedExtensions', 'user');
  const unrelated = path.join(root, 'Code', 'CachedExtensions', 'builtin');
  const context = {
    globalStorageUri: { fsPath: path.join(root, 'Code', 'User', 'globalStorage', 'pony-factor.sweetiebot-scm') }
  };
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, 'stale user manifest scan');
  fs.writeFileSync(unrelated, 'system manifest scan');
  assert.equal(userExtensionCachePath(context), cache);
  assert.equal(invalidateUserExtensionCache(context), true);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'system manifest scan');
  assert.equal(invalidateUserExtensionCache(context), false, 'missing cache is harmless');

  const profile = {
    globalStorageUri: { fsPath: path.join(root, 'Code', 'User', 'profiles', 'profile-id', 'globalStorage', 'pony-factor.sweetiebot-scm') }
  };
  assert.equal(userExtensionCachePath(profile), cache, 'named profiles share Code cache');
  assert.equal(userExtensionCachePath({}), undefined);
  assert.equal(userExtensionCachePath({ globalStorageUri: { fsPath: path.join(root, 'unrelated') } }), undefined);
  const victim = path.join(root, 'important');
  fs.writeFileSync(victim, 'preserved');
  fs.symlinkSync(victim, cache);
  assert.equal(invalidateUserExtensionCache(context), false, 'do not follow symlink cache entries');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserved');
  fs.unlinkSync(cache);
  fs.mkdirSync(cache);
  assert.equal(invalidateUserExtensionCache(context), false, 'do not remove a directory');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('VS Code extension manifest cache invalidation checks passed.');
