'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const polling = source.slice(
  source.indexOf('async function scmToolkitPullCleanRepository('),
  source.indexOf('const SCM_TOOLKIT_CODEX_COAUTHOR')
);
const binding = source.slice(
  source.indexOf('                if (\n                    (settings.blankStateRefresh'),
  source.indexOf('                const historyProvider = provider.historyProvider.read(reader);')
);
assert(binding, 'Exercise the repository polling binding as well as the timer');

async function check(settings, { dirty = false, ancestor = 'local', upstream = true, hidden = false } = {}) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let resourceListener;
  let visibilityListener;
  let disposable;
  const localRef = { id: 'refs/heads/main', revision: 'local' };
  const remoteRef = upstream ? { id: 'refs/remotes/origin/main', revision: 'remote' } : undefined;
  const provider = {
    groups: [{ resources: dirty ? [{}] : [] }],
    historyProvider: { get: () => ({
      historyItemRef: { get: () => localRef },
      historyItemRemoteRef: { get: () => remoteRef },
      async resolveHistoryItemRefsCommonAncestor() { return ancestor; }
    }) },
    onDidChangeResources(callback) {
      resourceListener = callback;
      return { dispose() { resourceListener = undefined; } };
    }
  };
  const doc = {
    hidden,
    defaultView: {
      setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
      clearTimeout(id) { timers.delete(id); }
    },
    addEventListener(event, callback) { visibilityListener = callback; },
    removeEventListener() { visibilityListener = undefined; }
  };
  const context = vm.createContext({
    settings,
    widget: { element: { ownerDocument: doc }, repositoryDisposables: {
      add(value) { disposable = value; }
    } },
    input: { repository: { provider } },
    commands: { async executeCommand(command, argument) {
      assert.equal(argument, 'selected-repository');
      calls.push(command);
      if (command === 'scmToolkit.autoPullClean') localRef.revision = remoteRef.revision;
    } },
    currentRepositoryArgument: 'selected-repository',
    blankStateRefreshDisposable: undefined
  });
  vm.runInContext(polling + binding, context);
  assert.equal(Boolean(disposable), settings.blankStateRefresh || settings.autoPullClean);

  async function tick() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    await timer.callback();
  }

  if (disposable && !dirty) {
    assert.equal([...timers.values()][0].delay, 300);
    await tick();
    const expected = hidden ? [] : [
      ...(settings.blankStateRefresh ? ['git.refresh'] : []),
      ...(settings.autoPullClean && upstream && ancestor === 'local' ? ['scmToolkit.autoPullClean'] : [])
    ];
    assert.deepEqual(calls, expected);
    assert.equal([...timers.values()][0].delay, hidden ? 5000 : 1500);
    await tick();
    assert.equal(calls.filter(command => command === 'scmToolkit.autoPullClean').length,
      expected.includes('scmToolkit.autoPullClean') ? 1 : 0, 'Do not pull again after catching up');
    provider.groups[0].resources = [{}];
    resourceListener();
    assert.equal(timers.size, 0, 'Dirty repositories stop polling');
    provider.groups[0].resources = [];
    resourceListener();
    assert.equal(timers.size, 1, 'Polling resumes once the repository is clean');
  } else {
    assert.equal(timers.size, 0);
    assert.deepEqual(calls, []);
  }
  disposable?.dispose();
  assert.equal(timers.size, 0);
  assert.equal(resourceListener, undefined);
  assert.equal(visibilityListener, undefined);
}

async function run() {
  for (const blankStateRefresh of [false, true]) {
    for (const autoPullClean of [false, true]) {
      await check({ blankStateRefresh, autoPullClean });
    }
  }
  const settings = { blankStateRefresh: false, autoPullClean: true };
  await check(settings, { dirty: true });
  await check(settings, { ancestor: 'diverged' });
  await check(settings, { upstream: false });
  await check(settings, { hidden: true });
  console.log('Automatic pull settings and clean-repository regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
