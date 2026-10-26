'use strict';

const assert = require('node:assert/strict');
const { createStackedBranch, linkPublishedStack } = require('../efs/branches/stacked_branch');

function fixture(tracked = false) {
  const calls = [];
  let current = 'parent';
  let sha = '0123456789';
  const repository = {
    rootUri: { fsPath: '/fictional/repository' },
    state: { HEAD: { name: current }, mergeChanges: [], indexChanges: [], workingTreeChanges: [] },
    async status() {},
    async getRefs() { return [{ name: 'parent' }, { name: 'origin/main' }, { name: 'origin/used' }]; },
    async checkout(branch) { calls.push(['checkout', branch]); current = branch; this.state.HEAD.name = branch; }
  };
  const execute = async (program, args) => {
    calls.push([program, ...args]);
    if (program === 'git' && args[0] === 'status') return { stdout: '' };
    if (program === 'git' && args[0] === 'rev-parse') return { stdout: sha };
    if (program === 'git' && args[0] === 'branch') return { stdout: current };
    if (program === 'git' && args[0] === 'switch') current = args[1];
    if (program === 'gh' && args[1] === 'view' && !tracked) {
      throw Object.assign(new Error('not in a stack'), { stderr: 'not in a stack' });
    }
    if (program === 'gh' && args[1] === 'add') current = args[2];
    return { stdout: '' };
  };
  const dependencies = {
    execute,
    loadHistory: async () => ({ file: null, selected: [] }),
    saveHistory: async () => {},
    randomInt: () => 0,
    openBranch: async (_vscode, _repository, options) => {
      calls.push(['route', options.branch, options.adoptExisting]);
      return true;
    }
  };
  return { repository, calls, dependencies, setSha: value => { sha = value; } };
}

async function run() {
  for (const tracked of [true, false]) {
    const { repository, calls, dependencies } = fixture(tracked);
    const branch = await createStackedBranch({}, repository,
      { parent: 'parent', defaultBranch: 'main', remote: 'origin', names: ['used', 'luna'] },
      dependencies);
    assert.equal(branch, 'luna');
    assert.equal(calls.some(c => c[0] === 'gh' && c[2] === 'init'), !tracked);
    assert(calls.some(c => c[0] === 'gh' && c[2] === 'add' && c[3] === 'luna'));
    assert(calls.some(c => c[0] === 'git' && c[1] === 'switch' && c[2] === 'parent'));
    assert(calls.some(c => c[0] === 'git' && c[1] === 'config' &&
      c.includes('branch.luna.sweetiebot-stack-parent') && c.includes('parent')));
    assert(calls.some(c => c[0] === 'route' && c[1] === 'luna' && c[2] === true));
  }

  const dirty = fixture(true);
  dirty.repository.state.indexChanges = [{}];
  await assert.rejects(createStackedBranch({}, dirty.repository,
    { parent: 'parent', defaultBranch: 'main', names: ['luna'] }, dirty.dependencies),
  /Commit or preserve pending changes/);
  assert(!dirty.calls.some(c => c[0] === 'gh'));

  const changed = fixture(true);
  changed.repository.state.HEAD.name = 'wrong';
  await assert.rejects(createStackedBranch({}, changed.repository,
    { parent: 'parent', defaultBranch: 'main', names: ['luna'] }, changed.dependencies),
  /selected parent branch changed/);
  assert(!changed.calls.some(c => c[0] === 'gh'));

  const commands = [];
  const execute = async (_, args) => {
    commands.push(args);
    if (args[0] === 'pr') {
      return { stdout: JSON.stringify(args[2] === 'parent'
        ? { number: 20, headRefName: 'parent', state: 'OPEN' }
        : { number: 21, headRefName: 'child', state: 'OPEN' }) };
    }
    return { stdout: '' };
  };
  assert.equal(await linkPublishedStack('/repo', 'https://github.com/org/repo',
    'child', 'parent', 'https://github.com/org/repo/pull/21', { execute }), true);
  assert.deepEqual(commands.at(-1), ['stack', 'link', '20', '21']);
  const prior = commands.length;
  assert.equal(await linkPublishedStack('/repo', 'https://github.com/org/repo',
    'child', 'parent', 'https://github.com/other/repo/pull/21', { execute }), false);
  assert.equal(commands.length, prior, 'Never link mismatched repositories');
  console.log('stacked branch tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
