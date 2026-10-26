'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  findBulkMergeScript, bulkMergeSelection, validateResult,
  invokeLindseyBulkMerge, runBulkMergeWithLindsey
} = require('../efs/merge/lindsey_bulk_merge');

async function run() {
  const source = [{
    number: 20, title: '🐞 Fix bug', head: 'some-branch',
    headSha: 'a'.repeat(40), base: 'main', headRepo: 'pony-factor/example'
  }];
  const selection = bulkMergeSelection('pony-factor/example', source);
  assert.equal(selection.pullRequests[0].headSha, 'a'.repeat(40));
  assert.throws(() => bulkMergeSelection('bad', source), /requires/);
  assert.throws(() => bulkMergeSelection('pony-factor/example',
    [source[0], source[0]]), /Duplicate/);
  assert.throws(() => bulkMergeSelection('pony-factor/example',
    [{ ...source[0], headSha: 'unknown' }]), /SHA/);

  const good = { version: 1, repository: 'pony-factor/example',
    results: [{ number: 20, base: 'main', status: 'merged',
      url: 'https://github.com/pony-factor/example/commit/' + 'b'.repeat(40) }] };
  assert.equal(validateResult(good, selection), good);
  assert.throws(() => validateResult({ ...good, results: [] }, selection), /incomplete/);
  assert.throws(() => validateResult({ ...good, results: [
    { number: 21, status: 'merged' }] }, selection), /unexpected/);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sweetiebot-lindsey-test-'));
  try {
    await fs.mkdir(path.join(tmp, 'lindsey-sync', 'scripts'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'lindsey-sync', 'scripts', 'resolve-conflicts.js'), '');
    await fs.writeFile(path.join(tmp, 'lindsey-sync', 'scripts', 'bulk-merge.js'), '');
    const found = findBulkMergeScript(path.join(tmp, 'other-repo'));
    assert.equal(found, path.join(tmp, 'lindsey-sync', 'scripts', 'bulk-merge.js'));

    let seen;
    const fakeExec = async (binary, args, options) => {
      assert.equal(binary, process.execPath);
      assert.equal(args[0], found);
      assert.equal(args[1], '--input');
      seen = args[2];
      const input = JSON.parse(await fs.readFile(seen, 'utf8'));
      assert.deepEqual(input, selection);
      assert.equal(options.env.GH_TOKEN, 'session-token');
      assert.equal((await fs.stat(seen)).mode & 0o077, 0);
      return { stdout: JSON.stringify(good) };
    };
    assert.deepEqual(await invokeLindseyBulkMerge(found, selection, 'session-token', fakeExec), good);
    await assert.rejects(fs.access(seen), /ENOENT/);
    // Separate-App mode uses the Lindsey installation, never the user's
    // session token, and does not propagate any App private keys to the CLI.
    const mode = {
      SWEETIEBOT_BOT_IDENTITY_MODE: 'separate-apps',
      SWEETIEBOT_LINDSEY_APP_PRIVATE_KEY: 'do-not-pass',
      SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY: 'also-do-not-pass'
    };
    let invoked = false;
    await invokeLindseyBulkMerge(found, selection, 'session-token',
      async (_binary, _args, options) => {
        invoked = true;
        assert.equal(options.env.GH_TOKEN, 'lindsey-token');
        assert.equal(options.env.GITHUB_TOKEN, 'lindsey-token');
        assert.equal(options.env.SWEETIEBOT_LINDSEY_APP_PRIVATE_KEY, undefined);
        assert.equal(options.env.SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY, undefined);
        return { stdout: JSON.stringify(good) };
      },
      { env: mode, async roleToken(role, repository) {
        assert.equal(role, 'lindsey');
        assert.equal(repository, 'pony-factor/example');
        return { token: 'lindsey-token' };
      } });
    assert(invoked);
    await assert.rejects(invokeLindseyBulkMerge(found, selection, 'session-token',
      async () => { throw Error('must not execute'); },
      { env: mode, async roleToken() { throw Error('App not installed'); } }),
    /App not installed/);


    if (process.platform === 'darwin') {
      const probe = path.join(tmp, 'probe.cjs');
      await fs.writeFile(probe, `
        require('node:child_process').execFileSync('gh', ['--version']);
        process.stdout.write(${JSON.stringify(JSON.stringify(good))});
      `);
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = '/usr/bin:/bin';
        assert.deepEqual(await invokeLindseyBulkMerge(probe, selection, 'session-token'), good);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    }

    const lines = [], notices = [];
    const vscode = {
      ProgressLocation: { Notification: 15 },
      window: {
        withProgress: async (_options, callback) => callback(),
        createOutputChannel: () => ({
          appendLine: line => lines.push(line),
          show() {}
        }),
        showInformationMessage: message => notices.push(message),
        showWarningMessage: message => notices.push(message)
      }
    };
    const output = await runBulkMergeWithLindsey(vscode, found,
      'pony-factor/example', source, 'session-token', async () => good);
    assert.equal(output.results[0].status, 'merged');
    assert(lines.some(line => line.includes('commit/')));
    assert(notices.some(line => line.includes('1 merged')));
    assert.equal(lines.some(line => line.includes('session-token')), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
