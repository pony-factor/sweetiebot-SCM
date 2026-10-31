'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { publishPonyProfile, pendingPonyProfiles } = require('../extension/commits/pony_git_publish');
const { createPonyPublishQueue, resolvePonyWorkerScript } = require('../extension/commits/pony_publish_queue');

const pony = { packId: 'g4-mares', slug: 'stardom' };
const stored = 'g4-mares/stardom.json';
const file = 'ponies/' + stored;
const initial = 'a'.repeat(40), committed = 'b'.repeat(40), other = 'c'.repeat(40);

// Model Git commands rather than creating commits or contacting any remote.
async function fixture(check) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pony-retry-'));
  const state = { head: initial, remote: initial, status: `?? ${file}`, pushes: 0, commits: 0,
    adds: 0, failPush: false, failFetch: false, published: false, commands: [] };
  const run = async (_command, args) => {
    const key = args.join(' ');
    state.commands.push(key);
    let stdout;
    if (key === 'rev-parse --show-toplevel') stdout = root;
    else if (key === 'rev-parse --absolute-git-dir') stdout = path.join(root, '.git');
    else if (key === 'symbolic-ref --quiet --short HEAD') stdout = 'main';
    else if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') stdout = 'origin/main';
    else if (args[0] === 'status') stdout = state.status;
    else if (key === 'fetch --quiet origin main') { if (state.failFetch) throw new Error('Network unavailable'); stdout = ''; }
    else if (key === 'rev-parse HEAD') stdout = state.head;
    else if (key === 'rev-parse refs/remotes/origin/main') stdout = state.remote;
    else if (key === 'merge-base HEAD refs/remotes/origin/main') stdout = state.remote;
    else if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      if (!state.published) throw new Error('Not published'); stdout = '';
    }
    else if (key === 'rev-parse HEAD^' || key === `rev-parse ${committed}^`) stdout = initial;
    else if (key === `rev-parse HEAD:${file}` || args[0] === 'hash-object') stdout = 'd'.repeat(40);
    else if (args[0] === 'diff-tree') stdout = file;
    else if (args[0] === 'add') { state.adds++; state.status = `A  ${file}`; stdout = ''; }
    else if (args[0] === 'diff') stdout = file;
    else if (args[0] === 'commit') { state.message = args[args.indexOf('-m') + 1]; state.commits++; state.head = committed; state.status = ''; stdout = ''; }
    else if (args[0] === 'log') stdout = state.message;
    else if (args[0] === 'push') {
      state.pushes++;
      assert.equal(args[2], `${committed}:refs/heads/main`, 'Push only the verified commit SHA');
      if (state.failPush) throw new Error('Push connection lost');
      state.remote = committed; state.published = true; stdout = '';
    } else throw new Error('Unexpected Git command: ' + key);
    return { stdout };
  };
  try {
    await fs.mkdir(path.join(root, 'ponies/g4-mares'), { recursive: true });
    await fs.writeFile(path.join(root, file), '{"profile":"Research"}\n');
    await check(root, state, run);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

(async () => {
  await fixture(async (root, state, run) => {
    state.failPush = true;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }), /connection lost/);
    const pending = await pendingPonyProfiles(root, { run });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].commit, committed);
    // A fresh call reads the durable receipt, as after an extension restart.
    state.failPush = false;
    assert.equal((await publishPonyProfile(root, pony, stored, { run })).pushed, true);
    assert.equal(state.commits, 1, 'Retry must not duplicate the commit');
    assert.equal(state.adds, 1, 'Retry must not stage anything again');
    assert.equal(state.pushes, 2);
    assert.deepEqual(await pendingPonyProfiles(root, { run }), []);
    assert.equal((await publishPonyProfile(root, pony, stored, { run })).reason, 'existing-profile-preserved');
  });
  await fixture(async (root, state, run) => {
    state.failPush = true;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }));
    const receiptPath = path.join(root, '.git/sweetiebot-pony-publish/g4-mares--stardom.json');
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    delete receipt.commit;
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
    state.failPush = false;
    assert.equal((await publishPonyProfile(root, pony, stored, { run })).pushed, true,
      'Recover the commit using parent, blob, path, and unique publication trailer');
    assert.equal(state.commits, 1);
  });
  await fixture(async (root, state, run) => {
    state.failPush = true;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }));
    const receiptPath = path.join(root, '.git/sweetiebot-pony-publish/g4-mares--stardom.json');
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    delete receipt.commit;
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
    state.message = 'A manual commit of the same content';
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }), /not a new/);
    assert.equal(state.pushes, 1, 'Never infer ownership of a manual commit from its contents alone');
  });
  await fixture(async (root, state, run) => {
    state.failFetch = true;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }), /Network/);
    assert.equal((await pendingPonyProfiles(root, { run })).length, 1);
    assert.equal(state.commits, 0);
    state.failFetch = false;
    assert.equal((await publishPonyProfile(root, pony, stored, { run })).pushed, true);
    assert.equal(state.commits, 1);
  });
  await fixture(async (root, state, run) => {
    state.failFetch = true;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }));
    // The user manually published a batch while automatic publication waited.
    state.failFetch = false; state.status = ''; state.head = other; state.remote = other;
    assert.equal((await publishPonyProfile(root, pony, stored, { run })).reason, 'already-published');
    assert.equal(state.adds, 0); assert.equal(state.commits, 0); assert.equal(state.pushes, 0);
    assert.deepEqual(await pendingPonyProfiles(root, { run }), []);
  });
  await fixture(async (root, state, run) => {
    state.failPush = true;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }));
    state.failPush = false; state.head = other;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }), /waiting/);
    assert.equal(state.pushes, 1, 'Never push unrelated local commits');
    state.head = committed; state.remote = other;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }), /waiting/);
    assert.equal(state.pushes, 1, 'Never rewrite a commit to resolve remote divergence');
    state.published = true;
    assert.equal((await publishPonyProfile(root, pony, stored, { run })).pushed, true);
    assert.equal(state.pushes, 1, 'Recognize a push that succeeded despite a connection error');
  });
  await fixture(async (root, state, run) => {
    state.head = other;
    await assert.rejects(publishPonyProfile(root, pony, stored, { run }), /local commits/);
    assert.equal(state.adds, 0); assert.equal(state.commits, 0); assert.equal(state.pushes, 0);
    assert.equal((await pendingPonyProfiles(root, { run })).length, 1, 'Retry after the manual commit is published');
  });

  // The packaged worker lives at the installed extension root, not in the
  // parent ~/.vscode/extensions/scripts directory from the old bad path.
  const installedCommits = '/fixture/.vscode/extensions/pony-factor.sweetiebot-scm-0.3.2/commits';
  const installedWorker = path.resolve(installedCommits, '../background_commit.py');
  const wrongWorker = path.resolve(installedCommits, '../../scripts/background_commit.py');
  assert.notEqual(installedWorker, wrongWorker);
  assert.equal(resolvePonyWorkerScript(installedCommits, candidate => candidate === installedWorker),
    installedWorker, 'Installed extensions use their own packaged worker');
  assert.throws(() => resolvePonyWorkerScript(installedCommits, candidate => candidate === wrongWorker),
    /worker is missing/, 'Never execute a worker outside the installed extension root');

  const sourceCommits = path.resolve(__dirname, '../extension/commits');
  const sourceWorker = path.resolve(sourceCommits, '../../scripts/background_commit.py');
  assert.equal(resolvePonyWorkerScript(sourceCommits, candidate => candidate === sourceWorker),
    sourceWorker, 'Running the extension from a source checkout remains supported');
  assert.throws(() => resolvePonyWorkerScript(installedCommits, () => false),
    /Repair the Sweetiebot extension/, 'A missing installed worker gets an actionable error');

  const calls = [];
  let failQueue = false;
  const queue = createPonyPublishQueue({
    pending: async () => [{ pony, path: stored }],
    script: '/fixture/background_commit.py',
    enqueue: async (script, directory, request, action) => {
      calls.push({ script, directory, request, action });
      if (failQueue) throw new Error('Worker is temporarily unavailable');
      return { queued: true, id: 'pony-durable-job' };
    }
  });
  await queue.resume('/fixture');
  assert.equal(calls.length, 1, 'Pending receipt is handed to the durable worker on startup');
  assert.equal(calls[0].action, '--enqueue-pony');
  assert.deepEqual(calls[0].request, { pony, path: stored });
  const first = await queue.enqueue('/fixture', pony, stored);
  assert.equal(first.retryScheduled, true, 'The worker—not the VS Code timer—owns retries');
  assert.equal(first.publication.queued, true);
  failQueue = true;
  const failed = await queue.enqueue('/fixture', pony, stored);
  assert.match(failed.publicationError, /temporarily unavailable/);
  assert.equal(failed.retryScheduled, undefined, 'Do not promise retries without an accepted job');
  failQueue = false;
  const again = await queue.enqueue('/fixture', pony, stored);
  assert.equal(again.retryScheduled, true, 'Existing journal can be re-enqueued after restart');
  queue.dispose();
  console.log('Pony publisher receipts, restart handoff, and detached-worker queue checks passed (mock Git).');
})().catch(error => { console.error(error); process.exitCode = 1; });
