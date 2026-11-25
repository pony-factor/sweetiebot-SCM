'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { maintain, consume, reap, noteFetch, freshBase } = require('../../extension/branches/prepared-worktrees');
const run = async args => (await promisify(execFile)('git', args)).stdout.trim();

test('prepared worktrees refresh, claim exclusively and preserve dirty or unreachable slots', async () => {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-prewarm-test-')));
  const root = path.join(tmp, 'repo'), base = path.join(tmp, 'workspaces');
  try {
    await run(['init', '-b', 'main', root]);
    const git = (...args) => run(['-C', root, ...args]);
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'Test');
    await fs.writeFile(path.join(root, 'tracked'), 'first\n');
    await git('add', 'tracked');
    await git('commit', '-m', 'first');
    const initial = await git('rev-parse', 'HEAD');
    const parent = path.join(base, 'repo');
    const slots = async () => (await fs.readdir(parent)).filter(name => name.startsWith('.prepared-')).sort();
    const receipt = async slot => JSON.parse(await fs.readFile(path.join(parent, slot, '.sweetiebot-prepared.json'), 'utf8'));
    const readyRoot = slot => path.join(parent, slot, 'repo');
    const maintainOptions = { base, count: 1, run, now: 1000 };
    await Promise.all([maintain(root, maintainOptions), maintain(root, maintainOptions)]);
    assert.equal((await slots()).length, 1);
    const slot = (await slots())[0];
    assert.equal((await receipt(slot)).sha, initial);
    assert.equal(await run(['-C', readyRoot(slot), 'branch', '--show-current']), '');
    assert.equal(await git('branch', '--list'), '* main');

    await fs.writeFile(path.join(root, 'tracked'), 'second\n');
    await git('commit', '-am', 'second');
    const second = await git('rev-parse', 'HEAD');
    await maintain(root, { ...maintainOptions, now: 2000 });
    assert.equal((await receipt(slot)).sha, second);
    assert.equal(await fs.readFile(path.join(readyRoot(slot), 'tracked'), 'utf8'), 'second\n');
    const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
    assert.equal(await consume(root, a, 'stale', initial, { base, count: 1, run }), false);
    const results = await Promise.all([
      consume(root, a, 'warm-a', second, { base, count: 1, run }),
      consume(root, b, 'warm-b', second, { base, count: 1, run })
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results[0] ? a : b;
    assert.equal(await run(['-C', winner, 'rev-parse', 'HEAD']), second);
    assert.equal(await git('branch', '--show-current'), 'main');
    assert.equal((await slots()).length, 0);

    await maintain(root, { ...maintainOptions, now: 3000 });
    await fs.writeFile(path.join(readyRoot(slot), 'private-edit'), 'keep');
    assert.equal(await consume(root, path.join(tmp, 'dirty'), 'dirty', second, { base, count: 1, run }), false);
    await reap(base, new Set(), { run, now: 10000, idleMs: 1 });
    assert.equal(await fs.readFile(path.join(readyRoot(slot), 'private-edit'), 'utf8'), 'keep');

    // A second clean slot may be reclaimed without touching the quarantined one.
    await maintain(root, { ...maintainOptions, count: 2, now: 3000 });
    const cleanSlot = (await slots()).find(name => name !== slot);
    await reap(base, new Set(), { run, now: 10000, idleMs: 1 });
    assert.equal((await slots()).includes(cleanSlot), false);
    assert.equal(await fs.readFile(path.join(readyRoot(slot), 'private-edit'), 'utf8'), 'keep');

    // A recent fetch is usable only while both local and tracking refs match.
    const remote = path.join(tmp, 'remote.git');
    await run(['init', '--bare', remote]);
    await git('remote', 'add', 'origin', remote);
    await git('push', '-u', 'origin', 'main');
    await git('fetch', 'origin', 'main');
    await noteFetch(root, 'origin', 'main', { run, now: 1000 });
    assert.equal(await freshBase(root, 'main', 'origin', { run, now: 2000 }), second);
    assert.equal(await freshBase(root, 'main', 'origin', { run, now: 61000 }), null);
    await git('update-ref', 'refs/heads/main', initial);
    assert.equal(await freshBase(root, 'main', 'origin', { run, now: 2000 }), null);
    await git('update-ref', 'refs/heads/main', second);
    await git('update-ref', 'refs/remotes/origin/main', initial);
    assert.equal(await freshBase(root, 'main', 'origin', { run, now: 2000 }), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
