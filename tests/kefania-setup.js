'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { launchKefaniaSetup, probeSetup } = require('../extension/codex/kefania-setup');

const url = 'http://127.0.0.1:8766/';

test('reuses an already-running Kefania setup service without starting a child', async () => {
  const result = await launchKefaniaSetup({
    probe: async () => 'ready',
    resolveFile: async () => assert.fail('Must not resolve a checkout for a running server'),
    spawnProcess: () => assert.fail('Must not start a duplicate service'), env: {}
  });
  assert.deepEqual(result, { url, reused: true });
});

test('opens a verified Kefania checkout only when the local port is free', async () => {
  const calls = [];
  const states = ['vacant', 'vacant', 'ready'];
  const result = await launchKefaniaSetup({
    env: {}, nodePath: '/opt/homebrew/bin/node', repositoryPath: '/home/project',
    probe: async () => states.shift(),
    resolveFile: async (repo, relative) => {
      assert.equal(repo, '/home/project');
      assert.equal(relative, path.join('src', 'setup-web.js'));
      return '/home/kefania/src/setup-web.js';
    },
    spawnProcess: (binary, args, options) => {
      calls.push({ binary, args, options });
      const process = new EventEmitter();
      process.unref = () => { calls.push('unref'); };
      queueMicrotask(() => process.emit('spawn'));
      return process;
    },
    wait: async () => {}
  });
  assert.deepEqual(result, { url, reused: false });
  assert.equal(calls[0].binary, '/opt/homebrew/bin/node');
  assert.deepEqual(calls[0].args, ['/home/kefania/src/setup-web.js']);
  assert.equal(calls[0].options.cwd, '/home/kefania');
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.KEFANIA_SETUP_PORT, '8766');
  assert.equal(calls[1], 'unref');
});

test('rejects an occupied port rather than redirecting to an unknown service', async () => {
  await assert.rejects(launchKefaniaSetup({
    env: {}, probe: async () => 'occupied',
    resolveFile: async () => assert.fail('Must not resolve checkout'),
    spawnProcess: () => assert.fail('Must not launch')
  }), /unverified service/);
});

test('does not advertise a failed launch as available', async () => {
  await assert.rejects(launchKefaniaSetup({
    env: {}, probe: async () => 'vacant',
    resolveFile: async () => '/tmp/kefania/src/setup-web.js',
    wait: async () => {},
    spawnProcess: () => {
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  }), /did not start/);
});

test('recognizes Kefania setup only when the bootstrap has the expected shape', async () => {
  const occupied = async () => true;
  const correct = async () => ({ ok: true, json: async () => ({ csrf: 'a'.repeat(24), settings: {}, connection: {} }) });
  const incorrect = async () => ({ ok: true, json: async () => ({ csrf: 'short', settings: {} }) });
  assert.equal(await probeSetup(8766, { fetchImpl: correct, occupied }), 'ready');
  assert.equal(await probeSetup(8766, { fetchImpl: incorrect, occupied }), 'occupied');
});
