'use strict';

const assert = require('node:assert/strict');
const { returnHome, createBranch, publishBranch, deleteBranch, syncBranch, registerBranchCommands, autoPullClean } = require('../efs/branch_actions');

const options = { defaultBranch: 'main', remote: 'origin', names: ['used', 'remote-used', 'fresh'] };

function fixture(onMain = false) {
  const calls = [];
  const repository = {
    state: { HEAD: onMain ? { name: 'main', upstream: { remote: 'origin', name: 'main' }, ahead: 0 } : { name: 'topic' }, mergeChanges: [] },
    inputBox: { value: 'Existing draft' },
    async status() { calls.push(['status']); },
    async checkout(name) {
      calls.push(['checkout', name]);
      this.state.HEAD = { name, upstream: { remote: 'origin', name: 'main' }, ahead: 0 };
    },
    async pull() { calls.push(['pull']); },
    async push(...args) { calls.push(['push', ...args]); },
    async fetch(opts) { calls.push(['fetch', opts]); },
    async merge(ref) { calls.push(['merge', ref]); },
    async getBranch(name) { return { name, upstream: { remote: 'origin', name: 'main' } }; },
    async getRefs(opts) {
      calls.push(['refs', opts]);
      if (opts.pattern === 'refs/heads') return [{ name: 'main' }, { name: 'topic' }];
      return [{ name: 'used' }, { name: 'origin/remote-used' }, { name: 'origin/main' }];
    },
    async createBranch(...args) { calls.push(['create', ...args]); },
    async deleteBranch(...args) { calls.push(['delete', ...args]); }
  };
  return { repository, calls };
}

async function run() {
  for (const state of [
    { ahead: 0, behind: 1 },
    { ahead: 1, behind: 1 },
    { ahead: 0, behind: 0 },
    { ahead: 0, behind: 1, dirty: 'indexChanges' },
    { ahead: 0, behind: 1, dirty: 'workingTreeChanges' },
    { ahead: 0, behind: 1, dirty: 'mergeChanges' }
  ]) {
    const { repository, calls } = fixture();
    repository.state.HEAD = { name: 'main', upstream: { remote: 'origin', name: 'main' },
      ahead: state.ahead, behind: state.behind };
    if (state.dirty) repository.state[state.dirty] = [{}];
    const expected = state.ahead === 0 && state.behind > 0 && state.dirty !== 'mergeChanges';
    assert.equal(await autoPullClean(repository), expected);
    assert.equal(calls.some(call => call[0] === 'merge'), expected);
  }
  {
    const { repository, calls } = fixture();
    repository.state.HEAD = { name: 'main', commit: 'local', upstream: { remote: 'origin', name: 'main' }, ahead: 0, behind: 0 };
    repository.fetch = async opts => { calls.push(['fetch', opts]); repository.state.HEAD.behind = 1; };
    assert.equal(await autoPullClean(repository, { fetch: true }), true);
    assert.deepEqual(calls.find(call => call[0] === 'fetch'), ['fetch', { remote: 'origin', ref: 'main' }]);
    assert.deepEqual(calls.find(call => call[0] === 'merge'), ['merge', 'origin/main']);
  }
  for (const mutation of ['name', 'commit', 'upstream', 'ahead']) {
    const { repository, calls } = fixture();
    repository.state.HEAD = { name: 'main', commit: 'local', upstream: { remote: 'origin', name: 'main' }, ahead: 0, behind: 1 };
    repository.fetch = async () => {
      if (mutation === 'upstream') repository.state.HEAD.upstream.name = 'other';
      else if (mutation === 'dirty') repository.state.indexChanges = [{}];
      else repository.state.HEAD[mutation] = mutation === 'ahead' ? 1 : 'changed';
    };
    assert.equal(await autoPullClean(repository, { fetch: true }), false);
    assert(!calls.some(call => call[0] === 'merge'));
  }
  for (const dirty of ['mergeChanges']) {
    const { repository, calls } = fixture();
    repository.state.HEAD = { name: 'main', upstream: { remote: 'origin', name: 'main' }, ahead: 0, behind: 1 };
    repository.state[dirty] = [{}];
    assert.equal(await autoPullClean(repository, { fetch: true }), false);
    assert(!calls.some(call => ['fetch', 'merge'].includes(call[0])));
  }
  {
    const { repository, calls } = fixture();
    assert.equal(await returnHome(repository), 'main');
    assert.deepEqual(calls, [['checkout', 'main'], ['status']]);
    assert.equal(repository.inputBox.value, 'Existing draft');
  }
  {
    const { repository, calls } = fixture();
    repository.checkout = async () => { throw new Error('Local changes would be overwritten'); };
    await assert.rejects(returnHome(repository), /Local changes would be overwritten/);
    assert.equal(repository.state.HEAD.name, 'topic');
    assert.deepEqual(calls, []);
  }
  {
    const { repository } = fixture();
    repository.checkout = async () => {};
    await assert.rejects(returnHome(repository), /Could not switch to main/);
  }
  {
    const { repository, calls } = fixture();
    assert.equal(await syncBranch(repository, { ...options, branch: 'topic' }), 'topic');
    assert.deepEqual(calls, [['status'], ['fetch', { remote: 'origin' }], ['status'], ['merge', 'origin/main'], ['status']]);
    assert.equal(repository.inputBox.value, 'Existing draft');
  }
  for (const branch of ['main', 'different']) {
    const { repository, calls } = fixture();
    await assert.rejects(syncBranch(repository, { ...options, branch }), /Cannot sync|active branch changed/);
    assert(!calls.some(call => call[0] === 'fetch' || call[0] === 'merge'));
  }
  {
    const { repository, calls } = fixture();
    repository.fetch = async () => { repository.state.HEAD.name = 'changed'; };
    await assert.rejects(syncBranch(repository, { ...options, branch: 'topic' }), /active branch changed/);
    assert(!calls.some(call => call[0] === 'merge'));
  }
  for (const conflict of [false, true]) {
    const { repository } = fixture();
    repository.merge = async () => {
      if (conflict) repository.state.mergeChanges.push({});
      throw new Error('merge failed');
    };
    await assert.rejects(syncBranch(repository, { ...options, branch: 'topic' }), /merge failed/);
    assert.equal(repository.inputBox.value, conflict ? '🔄 Sync branch with main' : 'Existing draft');
  }
  {
    const { repository } = fixture();
    repository.fetch = async () => { throw new Error('fetch failed'); };
    await assert.rejects(syncBranch(repository, { ...options, branch: 'topic' }), /fetch failed/);
    assert.equal(repository.inputBox.value, 'Existing draft');
    repository.fetch = async () => {};
    repository.merge = async () => { repository.inputBox.value = 'Edited during sync'; };
    await syncBranch(repository, { ...options, branch: 'topic' });
    assert.equal(repository.inputBox.value, 'Edited during sync');
  }
  {
    const { repository, calls } = fixture(true);
    assert.equal(await createBranch(repository, options, () => 0), 'fresh');
    assert.deepEqual(calls.at(-1), ['create', 'fresh', true, 'refs/heads/main']);
    assert(calls.findIndex(call => call[0] === 'merge') < calls.findIndex(call => call[0] === 'refs'));
    assert(!calls.some(call => call[0] === 'push'));
  }
  for (const method of ['fetch', 'merge', 'push']) {
    const { repository, calls } = fixture(true);
    if (method === 'push') repository.merge = async () => { repository.state.HEAD.ahead = 1; };
    repository[method] = async () => { throw new Error(`${method} failed`); };
    await assert.rejects(createBranch(repository, options), new RegExp(`${method} failed`));
    assert(!calls.some(call => call[0] === 'create'));
  }
  for (const dirty of ['indexChanges', 'workingTreeChanges']) {
    const { repository, calls } = fixture();
    const changes = [{}];
    repository.state[dirty] = changes;
    repository.merge = async () => { throw new Error('Local changes would be overwritten'); };
    assert.equal(await createBranch(repository, options, () => 0), 'fresh');
    assert.equal(repository.state[dirty], changes);
    assert.equal(repository.inputBox.value, 'Existing draft');
    assert.deepEqual(calls.at(-1), ['create', 'fresh', true, 'HEAD']);
    assert(!calls.some(call => ['fetch', 'merge', 'push'].includes(call[0])));
  }
  {
    const { repository, calls } = fixture();
    repository.state.mergeChanges = [{}];
    await assert.rejects(createBranch(repository, options), /Resolve the merge conflicts/);
    assert.deepEqual(calls, [['status']]);
  }
  for (const cancelled of [false, true]) {
    const { repository, calls } = fixture();
    repository.state.indexChanges = [{}];
    repository.checkout = async () => {
      if (!cancelled) throw new Error('Local changes would be overwritten');
    };
    await assert.rejects(createBranch(repository, options), /Local changes would be overwritten|Could not switch/);
    assert(!calls.some(call => ['fetch', 'merge', 'push', 'create'].includes(call[0])));
  }
  {
    const { repository, calls } = fixture(true);
    await createBranch(repository, options);
    assert(!calls.some(call => call[0] === 'checkout'), 'Already on main: no redundant checkout');
  }
  {
    const { repository, calls } = fixture(true);
    repository.state.HEAD = { name: 'main' };
    await assert.rejects(createBranch(repository, options), /must track/);
    assert(!calls.some(call => call[0] === 'create' || call[0] === 'merge'));
  }
  {
    const { repository, calls } = fixture(true);
    const getRefs = repository.getRefs;
    repository.getRefs = async opts => {
      const refs = await getRefs.call(repository, opts);
      repository.state.HEAD = { name: 'changed' };
      return refs;
    };
    await assert.rejects(createBranch(repository, options), /active branch changed/);
    assert(!calls.some(call => call[0] === 'create'));
  }
  {
    const { repository } = fixture(true);
    await assert.rejects(createBranch(repository, { ...options, names: ['used', 'remote-used'] }), /already in use/);
  }
  {
    const { repository, calls } = fixture();
    assert.equal(await publishBranch(repository, { branch: 'topic', remote: 'origin' }), true);
    assert.deepEqual(calls.at(-1), ['push', 'origin', 'topic', true]);
  }
  {
    const { repository, calls } = fixture();
    repository.state.HEAD.upstream = { remote: 'origin', name: 'topic' };
    assert.equal(await publishBranch(repository, { branch: 'topic', remote: 'origin' }), false);
    assert(!calls.some(call => call[0] === 'push'));
  }
  {
    const { repository, calls } = fixture();
    await assert.rejects(
      publishBranch(repository, { branch: 'other', remote: 'origin' }),
      /active branch changed/
    );
    assert(!calls.some(call => call[0] === 'push'));
  }
  {
    const { repository, calls } = fixture();
    await deleteBranch(repository, { ...options, branch: 'topic' });
    assert.deepEqual(calls[1], ['fetch', { remote: 'origin', prune: true }]);
    assert.deepEqual(calls.at(-1), ['delete', 'topic', false]);
    const advance = calls.findIndex(call => call[0] === 'fetch' && call[1].remote === '.');
    assert.deepEqual(calls[advance], ['fetch', { remote: '.', ref: 'refs/remotes/origin/main:refs/heads/main' }]);
    assert(advance < calls.findIndex(call => call[0] === 'checkout'));
    assert(!calls.some(call => ['merge', 'push'].includes(call[0])));
  }
  for (const refs of [[], [{ name: 'origin/topic' }]]) {
    const { repository, calls } = fixture();
    repository.getRefs = async () => refs;
    await assert.rejects(deleteBranch(repository, { ...options, branch: 'topic' }), /could not be verified|still exists/);
    assert(!calls.some(call => call[0] === 'checkout' || call[0] === 'delete'));
  }
  for (const branch of ['main', 'different']) {
    const { repository, calls } = fixture();
    await assert.rejects(deleteBranch(repository, { ...options, branch }), /Cannot delete|active branch changed/);
    assert(!calls.some(call => call[0] === 'fetch' || call[0] === 'delete'));
  }
  for (const method of ['fetch', 'deleteBranch']) {
    const { repository } = fixture();
    repository[method] = async () => { throw new Error(`${method} failed`); };
    await assert.rejects(deleteBranch(repository, { ...options, branch: 'topic' }), new RegExp(`${method} failed`));
  }
  {
    const { repository } = fixture();
    repository.deleteBranch = async () => { throw new Error('Failed to execute git'); };
    const getRefs = repository.getRefs;
    repository.getRefs = async opts => opts.pattern === 'refs/heads' ? [{ name: 'main' }] : getRefs(opts);
    assert.equal(await deleteBranch(repository, { ...options, branch: 'topic' }), 'topic');
    assert.equal(repository.state.HEAD.name, 'main');
  }
  for (const verified of [true, false]) {
    const { repository } = fixture();
    repository.deleteBranch = async () => {
      throw Object.assign(new Error('Failed to execute git'), { stderr: "error: The branch 'topic' is not fully merged." });
    };
    let cleaned = false;
    const getRefs = repository.getRefs;
    repository.getRefs = async opts => cleaned && verified && opts.pattern === 'refs/heads'
      ? [{ name: 'main' }] : getRefs(opts);
    const operation = deleteBranch(repository, { ...options, branch: 'topic' }, async (repo, branch) => {
      assert.equal(repo.state.HEAD.name, 'main');
      assert.equal(branch, 'topic');
      cleaned = true;
    });
    if (verified) assert.equal(await operation, 'topic');
    else await assert.rejects(operation, /could not be verified.*preserved/);
    assert(cleaned);
  }
  {
    const { repository, calls } = fixture(true);
    repository.merge = async () => { repository.state.HEAD.ahead = 2; };
    await createBranch(repository, options, () => 0);
    assert.deepEqual(calls.find(call => call[0] === 'push'), ['push', 'origin', 'main:main']);
  }
  {
    const { repository, calls } = fixture(true);
    // The old pull request stays rejected, but it must no longer be used.
    repository.pull = async () => { throw new Error('cached timeout'); };
    let attempts = 0;
    repository.fetch = async () => {
      calls.push(['fetch']);
      if (++attempts === 1) throw Object.assign(new Error('Failed to execute git'), {
        stderr: 'Recv failure: Operation timed out'
      });
    };
    assert.equal(await createBranch(repository, options, () => 0), 'fresh');
    assert.equal(attempts, 2);
    assert.equal(repository.inputBox.value, 'Existing draft');
  }
  for (const failure of ['timeout', 'Authentication failed']) {
    const { repository, calls } = fixture(true);
    let attempts = 0;
    repository.fetch = async () => { attempts++; throw new Error(failure); };
    await assert.rejects(createBranch(repository, options), new RegExp(failure));
    assert.equal(attempts, failure === 'timeout' ? 3 : 1);
    assert(!calls.some(call => call[0] === 'create' || call[0] === 'merge' || call[0] === 'push'));
  }
  {
    const { repository, calls } = fixture(true);
    repository.fetch = async () => { repository.state.HEAD.name = 'changed'; };
    await assert.rejects(createBranch(repository, options), /active branch changed/);
    assert(!calls.some(call => call[0] === 'merge' || call[0] === 'create'));
  }
  {
    const { repository, calls } = fixture(true);
    repository.merge = async () => {
      repository.state.mergeChanges.push({});
      throw new Error('CONFLICT (content): Merge conflict');
    };
    await assert.rejects(createBranch(repository, options), /CONFLICT/);
    assert(!calls.some(call => call[0] === 'push' || call[0] === 'create'));
  }
  for (const failure of ['non-fast-forward', 'Recv failure: Connection reset by peer']) {
    const { repository, calls } = fixture(true);
    repository.merge = async ref => {
      calls.push(['merge', ref]);
      repository.state.HEAD.ahead = 2;
    };
    let attempts = 0;
    repository.push = async (...args) => {
      calls.push(['push', ...args]);
      if (++attempts === 1) throw Object.assign(new Error('Failed to execute git'), { stderr: failure });
    };
    assert.equal(await createBranch(repository, options, () => 0), 'fresh');
    assert.equal(attempts, 2);
    assert.equal(calls.filter(call => call[0] === 'fetch').length, failure === 'non-fast-forward' ? 2 : 1);
    assert(calls.filter(call => call[0] === 'push').every(call => call.length === 3));
  }
  {
    const { repository, calls } = fixture(true);
    repository.merge = async () => { repository.state.HEAD.ahead = 1; };
    let attempts = 0;
    repository.push = async () => { attempts++; throw new Error('non-fast-forward'); };
    await assert.rejects(createBranch(repository, options), /non-fast-forward/);
    assert.equal(attempts, 3);
    assert(!calls.some(call => call[0] === 'create'));
  }
  {
    const { repository } = fixture();
    const commands = new Map();
    const uri = { scheme: 'file', path: '/selected-repository' };
    const vscode = {
      Uri: { from(components) {
        assert.equal(components.scheme, uri.scheme);
        assert.equal(components.path, uri.path);
        return uri;
      } },
      commands: { registerCommand(id, callback) { commands.set(id, callback); return { dispose() {} }; } },
      extensions: { getExtension(id) {
        assert.equal(id, 'vscode.git');
        return { async activate() { return { getAPI(version) {
          assert.equal(version, 1);
          return { getRepository(selected) { assert.equal(selected, uri); return repository; } };
        } }; } };
      } }
    };
    const context = { subscriptions: [] };
    registerBranchCommands(vscode, context);
    assert.equal(context.subscriptions.length, 9);
    assert.equal(await commands.get('sweetiebot.returnHome')({ rootUri: uri }), 'main');
    assert.equal(await commands.get('sweetiebot.createBranch')(uri, options), 'fresh');
    assert.equal(await commands.get('sweetiebot.createBranch')({ ...uri }, options), 'fresh');
    assert.equal(await commands.get('sweetiebot.createBranch')({ rootUri: uri }, options), 'fresh');
    repository.state.HEAD = { name: 'topic' };
    assert.equal(await commands.get('sweetiebot.publishBranch')({ rootUri: uri }, {
      branch: 'topic', remote: 'origin'
    }), true);
    repository.state.HEAD = { name: 'topic' };
    assert.equal(await commands.get('sweetiebot.syncBranch')({ rootUri: uri }, {
      ...options, branch: 'topic'
    }), 'topic');
    assert.equal(await commands.get('sweetiebot.deleteBranch')({ rootUri: uri }, {
      ...options, branch: 'topic'
    }), 'topic');

    // Polling sees main behind during cleanup, but its update must wait until
    // cleanup finishes and then recheck the now-current branch state.
    repository.state.HEAD = { name: 'topic' };
    let releaseMerge;
    let startedMerge;
    const started = new Promise(resolve => { startedMerge = resolve; });
    const gate = new Promise(resolve => { releaseMerge = resolve; });
    let merges = 0;
    repository.fetch = async ({ remote }) => {
      if (remote !== '.') return;
      merges++;
      repository.state.HEAD.behind = 1;
      startedMerge();
      await gate;
      repository.state.HEAD.behind = 0;
    };
    const deletion = commands.get('sweetiebot.deleteBranch')({ rootUri: uri }, {
      ...options, branch: 'topic'
    });
    await started;
    const background = commands.get('sweetiebot.autoPullClean')({ rootUri: uri });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(merges, 1, 'Background updates must not overlap branch cleanup');
    releaseMerge();
    assert.equal(await deletion, 'topic');
    assert.equal(await background, false, 'Recheck state after waiting for cleanup');
    assert.equal(merges, 1);

    repository.checkout = async () => { throw new Error('Checkout blocked'); };
    await assert.rejects(commands.get('sweetiebot.returnHome')(uri), /Checkout blocked/);
    assert.equal(await commands.get('sweetiebot.autoPullClean')(uri), false,
      'A failed operation must not block subsequent background work');
  }
  console.log('Branch action regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
