'use strict';

const assert = require('node:assert/strict');
const {
  CONTEXT_KEY,
  PonyProfileViewProvider,
  STATE_KEY,
  displayName,
  normalizePonyProfile,
} = require('../efs/pony_profile');

async function run() {
  assert.equal(displayName('berry-punch'), 'Berry Punch');
  assert.equal(displayName('moon-dancer'), 'Moon Dancer');
  assert.equal(normalizePonyProfile(undefined), undefined);
  assert.equal(normalizePonyProfile({}), undefined);

  assert.deepEqual(
    normalizePonyProfile({
      slug: 'berry-punch',
      packId: 'g4-mares',
      packLabel: 'G4 mares',
      packDescription: 'Named adult female G4 ponies.',
      source: 'https://example.com/berry'
    }),
    {
      slug: 'berry-punch',
      name: 'Berry Punch',
      packId: 'g4-mares',
      packLabel: 'G4 mares',
      packDescription: 'Named adult female G4 ponies.',
      source: 'https://example.com/berry'
    }
  );
  assert.equal(
    normalizePonyProfile({ slug: 'berry-punch', source: 'javascript:alert(1)' }).source,
    undefined
  );

  const updates = [];
  const commands = [];
  const external = [];
  const posted = [];
  const listeners = [];
  const context = {
    workspaceState: {
      get(key) { assert.equal(key, STATE_KEY); return undefined; },
      async update(key, value) { updates.push({ key, value }); }
    }
  };
  const vscode = {
    commands: { async executeCommand(...args) { commands.push(args); } },
    env: { async openExternal(uri) { external.push(uri.value); } },
    Uri: { parse(value) { return { value }; } }
  };
  const provider = new PonyProfileViewProvider(vscode, context);
  await provider.initialize();
  assert.deepEqual(commands[0], ['setContext', CONTEXT_KEY, false]);

  provider.resolveWebviewView({
    webview: {
      cspSource: 'vscode-webview:',
      options: undefined,
      html: '',
      postMessage(message) { posted.push(message); },
      onDidReceiveMessage(listener) { listeners.push(listener); }
    }
  });
  assert.equal(posted.length, 0);
  await listeners[0]({ type: 'ready' });
  assert.equal(posted.at(-1).profile, null);

  const profile = await provider.setProfile({
    slug: 'berry-punch',
    packId: 'g4-mares',
    packLabel: 'G4 mares',
    source: 'https://example.com/berry'
  });
  assert.equal(profile.name, 'Berry Punch');
  assert.equal(updates.at(-1).key, STATE_KEY);
  assert.deepEqual(commands.at(-1), ['setContext', CONTEXT_KEY, true]);
  assert.equal(posted.at(-1).profile.slug, 'berry-punch');

  await listeners[0]({ type: 'openSource' });
  assert.deepEqual(external, ['https://example.com/berry']);

  await listeners[0]({ type: 'clear' });
  assert.equal(updates.at(-1).value, undefined);
  assert.deepEqual(commands.at(-1), ['setContext', CONTEXT_KEY, false]);

  console.log('Pony profile sidebar checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
