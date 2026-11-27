'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, localUrl, checkoutId, repositoryKey, suggestedArgs, waitForReady, openDevelopmentUrl, openRegularBrave, chooseBraveCookieSource, launchIsolatedBrave, registerDevelopmentLauncher } = require('../../extension/branches/development-launcher');

(async () => {
  assert.deepEqual(parseArgs('["npm","run","dev","a b"]'), ['npm', 'run', 'dev', 'a b']);
  for (const input of ['"npm run dev"', '[]', '[42]', '[""]', '["npm",null]'])
    assert.throws(() => parseArgs(input));
  assert.equal(localUrl('http://localhost:5173'), 'http://localhost:5173/');
  assert.equal(localUrl('http://[::1]:8080'), 'http://[::1]:8080/');
  for (const url of ['https://example.com', 'http://localhost.example.com', 'file:///tmp/test', 'http://user@localhost'])
    assert.throws(() => localUrl(url));
  assert.notEqual(checkoutId('/a/repo'), checkoutId('/b/repo'));
  assert.equal(await repositoryKey('/a repo', 'origin'), 'origin');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-dev-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    assert.equal(await repositoryKey(root), await fs.realpath(path.join(root, '.git')));
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
  const regularBrave = {
    env: { clipboard: { writeText: async text => calls.push(['clipboard', text]) } },
    window: {
      showQuickPick: async () => undefined,
      showInformationMessage: () => {}
    }
  };
  const run = async (...args) => calls.push(args);
  await openRegularBrave(regularBrave, '/a repo', 'https://chatgpt.com/', run);
  assert.deepEqual(calls, []);
  regularBrave.window.showQuickPick = async choices => choices.find(choice => choice.kind === 'setup');
  await openRegularBrave(regularBrave, '/a repo', 'https://chatgpt.com/', run);
  assert.deepEqual(calls.splice(0), [
    ['clipboard', '/a repo'],
    ['/usr/bin/open', ['-a', 'Brave Browser', 'brave://extensions/']]
  ]);
  regularBrave.window.showQuickPick = async choices => choices.find(choice => choice.kind === 'open');
  await openRegularBrave(regularBrave, '/a repo', 'https://chatgpt.com/', run);
  assert.deepEqual(calls.splice(0), [['/usr/bin/open', ['-a', 'Brave Browser', 'https://chatgpt.com/']]]);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-brave-seed-'));
  try {
    const runner = async (...args) => calls.push(args);
    const normal = path.join(profile, 'normal');
    const repository = path.join(profile, 'repository');
    const testProfile = path.join(repository, 'profile');
    for (const name of ['Default', 'Profile 2']) {
      await fs.mkdir(path.join(normal, name, 'Network'), { recursive: true });
      await fs.writeFile(path.join(normal, name, 'Network', 'Cookies'), 'synthetic');
    }
    let choice;
    let asked = 0;
    const host = { window: {
      showWarningMessage: async () => { asked++; return choice; },
      showQuickPick: async options => { assert.deepEqual(options, ['Default', 'Profile 2']); return 'Profile 2'; }
    } };
    assert.equal(await chooseBraveCookieSource(host, testProfile, normal), false);
    choice = 'Launch without copying';
    assert.equal(await chooseBraveCookieSource(host, testProfile, normal), undefined);
    choice = 'Copy encrypted cookies';
    assert.equal(await chooseBraveCookieSource(host, testProfile, normal), 'Profile 2');
    await fs.mkdir(path.join(testProfile, 'Default'), { recursive: true });
    await fs.writeFile(path.join(testProfile, 'Default/Cookies'), 'synthetic');
    assert.equal(await chooseBraveCookieSource(host, testProfile, normal), undefined);
    await launchIsolatedBrave(host, '/a repo', repository, { url: 'https://chatgpt.com/', copyBraveCookies: true }, runner);
    assert.equal(asked, 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'python3');
    assert.deepEqual(calls[0][1].slice(1), ['/a repo', repository, 'https://chatgpt.com/']);
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
