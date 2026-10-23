'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { validateResolution, executeResolution, invokeResolutionCLI } = require('../efs/merge_resolution');
const { createMergeHandoff } = require('../efs/merge_handoff');
const { patchPaths, safePatchPath } = require('../efs/merge_patch');
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const selection = { repository: 'owner/repo', pullRequests: [{ number: 12,
  title: 'Fix a conflict', head: 'feature', base: 'main', headSha: head,
  url: 'https://github.com/owner/repo/pull/12' }] };
const input = { version: 1, repository: 'owner/repo', results: [{
  number: 12, headSha: head, baseSha: base, patch: null, explanation: 'Preserve the human Git author.'
}] };

(async () => {
  for (const bad of [
    { ...input, repository: 'other/repo' }, { ...input, results: [input.results[0], input.results[0]] },
    ...[{ number: 13 }, { headSha: 'c'.repeat(40) }, { baseSha: '' }, { patch: '' }, { patch: 'x'.repeat(60001) }]
      .map(change => ({ ...input, results: [{ ...input.results[0], ...change }] }))
  ]) assert.throws(() => validateResolution(bad, selection));
  let calls = 0;
  const empty = { ...input, results: [] };
  assert.deepEqual(validateResolution(empty, selection), []);
  assert.deepEqual(await executeResolution(empty, selection, {
    merge: async () => assert.fail('An empty handoff must never invoke Git or GitHub merging')
  }), { repository: selection.repository, results: [] });
  assert.deepEqual(await invokeResolutionCLI(empty, selection, undefined),
    { repository: selection.repository, results: [] },
    'A blocked batch completes through the real child CLI without GitHub writes');
  const result = await executeResolution(input, selection, { merge: async (repo, number, options) => {
    calls++;
    assert.equal(repo, 'owner/repo'); assert.equal(number, 12);
    assert.equal(options.expected.headSha, head); assert.equal(options.expected.base, 'main');
    assert.equal(options.resolutionPatch, null);
    return { merged: true, sha: 'c'.repeat(40) };
  } });
  assert.equal(calls, 1); assert.equal(result.results[0].status, 'merged');
  const blocked = await executeResolution(input, selection, { merge: async () => { throw Error('Stale base'); } });
  assert.equal(blocked.results[0].status, 'blocked');
  assert.match(blocked.results[0].reason, /Stale/);
  let inputFile;
  await invokeResolutionCLI(input, selection, 'session-token', async (binary, args, options) => {
    inputFile = args[2];
    assert(args[0].endsWith('merge_resolution_cli.js'));
    assert.equal(args[1], '--input');
    assert.equal(options.env.GH_TOKEN, 'session-token');
    assert(!args.includes('session-token'), 'Never pass credentials in process arguments');
    assert.deepEqual(JSON.parse(await fs.readFile(inputFile, 'utf8')), { input, selection });
    return { stdout: JSON.stringify(result) };
  });
  await assert.rejects(fs.stat(inputFile), /ENOENT/);
  assert.deepEqual(patchPaths('diff --git a/file.txt b/file.txt\n', '1\t1\tfile.txt\0', ['file.txt']), ['file.txt']);
  for (const name of ['../escape', '/absolute', '.git/config', '.env', '.env.local', 'keys/private.pem', 'secrets.json', 'folder/id_rsa', 'folder\\escape']) {
    assert.equal(Boolean(safePatchPath(name)), false, name);
    assert.throws(() => patchPaths('', '1\t1\t' + name + '\0', [name]));
  }
  assert.throws(() => patchPaths('new file mode 120000\n', '1\t0\tfile.txt\0', ['file.txt']), /regular text/);
  assert.throws(() => patchPaths('', '1\t1\tunrelated.txt\0', ['file.txt']), /unrelated/);
  assert.throws(() => patchPaths('GIT binary patch\n', '', ['file.txt']), /regular text/);

  let executions = 0, finish;
  const bridge = await createMergeHandoff(selection, { execute: async () => {
    executions++;
    await new Promise(resolve => { finish = resolve; });
    return result;
  } });
  try {
    const url = new URL(bridge.url);
    const post = (data, headers = {}) => new Promise((resolve, reject) => {
      const request = http.request(url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url.origin, ...headers } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode,
          json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on('error', reject);
      request.end(JSON.stringify(data));
    });
    assert.equal((await fetch(url)).status, 200, 'GET only serves the intake page');
    assert.equal(executions, 0);
    assert.equal((await post(input, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await post(input, { Host: 'evil.invalid' })).status, 404);
    assert.equal((await post({ ...input, results: [{ ...input.results[0], number: 99 }] })).status, 400);
    assert.equal(executions, 0);
    const pending = post(input);
    const deadline = Date.now() + 5000;
    while (!finish && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert(finish, 'Valid POST should reach the local executor');
    assert.equal((await post(input)).status, 409, 'Do not run a concurrent duplicate');
    finish();
    assert.equal((await pending).status, 200);
    assert.deepEqual(await (await post(input)).json(), result, 'Replay returns the recorded result');
    assert.equal(executions, 1);
  } finally { bridge.dispose(); }
  console.log('Selected-patch validation, local CLI intake, origin guards, replay and credential transport checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
