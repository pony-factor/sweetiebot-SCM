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

async function check(settings, { dirty = false, ancestor = 'local', upstream = true, hidden = false, slowAutoPull = false } = {}) {
  const calls = [];
  let clock = 0;
  const timers = new Map();
  let nextTimer = 0;
  let resourceListener;
  let visibilityListener;
  let disposable;
  let finishAutoPull;
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
    Date: { now: () => clock },
    settings,
    widget: { element: { ownerDocument: doc }, repositoryDisposables: {
      add(value) { disposable = value; }
    } },
    input: { repository: { provider } },
    commands: { async executeCommand(command, argument, options) {
      assert.equal(argument, 'selected-repository');
      calls.push(command);
      if (options) assert.equal(options.fetch, true);
      if (command === 'sweetiebot.autoPullClean' && slowAutoPull && options?.fetch && !finishAutoPull) {
        return new Promise(resolve => {
          finishAutoPull = () => {
            if (upstream && ancestor === 'local') localRef.revision = remoteRef.revision;
            resolve();
          };
        });
      }
      if (command === 'sweetiebot.autoPullClean' && upstream && ancestor === 'local') localRef.revision = remoteRef.revision;
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
    await new Promise(resolve => setImmediate(resolve));
  }

  if (disposable && !dirty) {
    assert.equal([...timers.values()][0].delay, 300);
    await tick();
    const expected = hidden ? [] : [
      ...(settings.blankStateRefresh ? ['git.refresh'] : []),
      ...(settings.autoPullClean ? ['sweetiebot.autoPullClean'] : [])
    ];
    assert.deepEqual(calls, expected);
    assert.equal([...timers.values()][0].delay, hidden ? 5000 : 750);
    await tick();
    if (slowAutoPull) {
      assert.equal(calls.filter(command => command === 'git.refresh').length, 2,
        'SCM keeps refreshing even when an upstream fetch has not completed');
      assert.equal(calls.filter(command => command === 'sweetiebot.autoPullClean').length, 1,
        'SCM does not launch a second fetch while one is outstanding');
      finishAutoPull();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(calls.filter(command => command === 'sweetiebot.autoPullClean').length,
      expected.includes('sweetiebot.autoPullClean') ? 1 : 0, 'Do not pull again after catching up');
    if (settings.autoPullClean && !hidden) {
      clock += 60000;
      await tick();
      assert.equal(calls.filter(command => command === 'sweetiebot.autoPullClean').length, 2,
        'Fetch again after one minute even when local and remote refs already match');
    }
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
  await check({ blankStateRefresh: true, autoPullClean: true }, { slowAutoPull: true });
  console.log('Automatic pull settings and clean-repository regression checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
