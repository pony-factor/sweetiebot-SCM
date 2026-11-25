'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, localUrl, checkoutId, braveArgs, suggestedArgs, waitForReady, openDevelopmentUrl, seedBraveProfile, registerDevelopmentLauncher } = require('../../extension/branches/development-launcher');

(async () => {
  assert.deepEqual(parseArgs('["npm","run","dev","a b"]'), ['npm', 'run', 'dev', 'a b']);
  for (const input of ['"npm run dev"', '[]', '[42]', '[""]', '["npm",null]'])
    assert.throws(() => parseArgs(input));
  assert.equal(localUrl('http://localhost:5173'), 'http://localhost:5173/');
  assert.equal(localUrl('http://[::1]:8080'), 'http://[::1]:8080/');
  for (const url of ['https://example.com', 'http://localhost.example.com', 'file:///tmp/test', 'http://user@localhost'])
    assert.throws(() => localUrl(url));
  assert.notEqual(checkoutId('/a/repo'), checkoutId('/b/repo'));
  assert.deepEqual(braveArgs('/a repo', '/my profile', 'https://chatgpt.com/'), [
    '-na', 'Brave Browser', '--args', '--user-data-dir=/my profile', '--disable-extensions-except=/a repo',
    '--load-extension=/a repo', '--no-first-run', '--no-default-browser-check', '--new-window', 'https://chatgpt.com/'
  ]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-dev-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node app', dev: 'vite' } }));
    assert.deepEqual(await suggestedArgs(root), ['npm', 'run', 'dev']);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node app' } }));
    assert.deepEqual(await suggestedArgs(root), ['npm', 'start']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  const calls = [];
  const browser = { commands: {
    getCommands: async () => ['workbench.action.browser.open'],
    executeCommand: async (...args) => calls.push(args)
  }, workspace: { getConfiguration: () => ({ get: () => 'global' }) },
    env: { openExternal: async url => calls.push(['external', url]) }, Uri: { parse: url => url } };
  await openDevelopmentUrl(browser, 'http://localhost:5173/', 'integrated');
  assert.deepEqual(calls.pop(), ['workbench.action.browser.open', { url: 'http://localhost:5173/', openToSide: false }]);
  await openDevelopmentUrl(browser, 'http://localhost:5173/');
  assert.deepEqual(calls.pop(), ['external', 'http://localhost:5173/']);
  browser.workspace.getConfiguration = () => ({ get: () => 'ephemeral' });
  await assert.rejects(openDevelopmentUrl(browser, 'http://localhost:5173/', 'integrated'), /persistent/);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-brave-seed-'));
  try {
    const runner = async (...args) => calls.push(args);
    let choice;
    const host = { window: { showWarningMessage: async () => choice } };
    assert.equal(await seedBraveProfile(host, profile, runner), false);
    assert.equal(calls.length, 0);
    choice = 'Launch without copying';
    await seedBraveProfile(host, profile, runner);
    assert.equal(calls.length, 0);
    choice = 'Copy encrypted cookies';
    await seedBraveProfile(host, profile, runner);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'python3');
    assert.equal(calls[0][1][1], profile);
    await fs.mkdir(path.join(profile, 'Default'));
    await fs.writeFile(path.join(profile, 'Default/Cookies'), 'synthetic');
    await seedBraveProfile(host, profile, runner);
    assert.equal(calls.length, 1);
  } finally { await fs.rm(profile, { recursive: true, force: true }); }

  let checks = 0;
  assert.equal(await waitForReady('http://localhost', () => true, { check: async () => ++checks === 2, pause: async () => {}, attempts: 3 }), true);
  assert.equal(checks, 2);
  assert.equal(await waitForReady('http://localhost', () => false, { check: async () => { throw Error('must not probe'); } }), false);
  assert.equal(await waitForReady('http://localhost', () => true, { check: async () => false, pause: async () => {}, attempts: 2 }), false);
  assert.equal(await waitForReady('http://localhost', () => checks < 3, { check: async () => { checks++; return true; } }), false);

  let handler, errors = [];
  const vscode = { workspace: { isTrusted: false }, env: {}, window: { showErrorMessage: message => errors.push(message) },
    commands: { registerCommand: (name, callback) => { assert.equal(name, 'sweetiebot.launchDevelopment'); handler = callback; return {}; } } };
  registerDevelopmentLauncher(vscode, { subscriptions: [] });
  await handler();
  assert.match(errors.pop(), /trusted local workspace/);
  vscode.workspace.isTrusted = true;
  vscode.env.remoteName = 'ssh-remote';
  await handler();
  assert.match(errors.pop(), /trusted local workspace/);
  console.log('development launcher tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
