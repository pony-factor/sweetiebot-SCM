'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('async function scmToolkitPushWithPullRetry(');
const end = source.indexOf('function scmToolkitCreateControls(', start);
const snippet = source.slice(start, end);

async function run(allowed, failCommit = false) {
  let commits = 0;
  const calls = [];
  const repository = {
    rootUri: { scheme: 'file', fsPath: '/tmp/repo' },
    async commit() {
      commits += 1;
      calls.push('commit');
      if (failCommit) throw new Error('commit failed');
    },
    async push() {}
  };
  const commands = {
    async executeCommand(command) {
      if (command === 'sweetiebot.queueCommit') return undefined;
      calls.push(command);
      if (command === 'sweetiebot.checkCommitLimits') return allowed;
      if (command === 'sweetiebot.beginCommit' || command === 'sweetiebot.endCommit') return undefined;
      throw new Error(`Unexpected command: ${command}`);
    }
  };
  const configuration = { getValue() { return 'none'; } };
  const notifications = { error() {} };
  const context = vm.createContext({ repository, commands, configuration, notifications });
  vm.runInContext(
    snippet + '\nscmToolkitGuardCommit(repository, commands, configuration, notifications);',
    context
  );
  try {
    await repository.commit('message', {});
  } catch (error) {
    if (!failCommit) throw error;
  }
  return { commits, calls };
}

(async () => {
  const cancelled = await run(false);
  assert.equal(cancelled.commits, 0, 'Closing the warning must cancel the commit');
  assert.deepEqual(cancelled.calls, ['sweetiebot.checkCommitLimits']);

  const allowed = await run(true);
  assert.equal(allowed.commits, 1, 'Commit anyway must allow the commit');
  assert.deepEqual(allowed.calls, [
    'sweetiebot.checkCommitLimits',
    'sweetiebot.beginCommit',
    'commit',
    'sweetiebot.endCommit'
  ]);

  const failed = await run(true, true);
  assert.equal(failed.commits, 1);
  assert.equal(failed.calls.at(-1), 'sweetiebot.endCommit',
    'A failed Git commit must still release the auto-pull pause');
  for (const pushFails of [false, true]) {
    const events = [];
    let finishPush;
    const repository = {
      rootUri: { fsPath: '/tmp/repo' }, HEAD: { name: 'topic' },
      async commit() { events.push('commit'); },
      async push() {
        events.push('push');
        await new Promise(resolve => { finishPush = resolve; });
        if (pushFails) throw new Error('push failed');
      }
    };
    const commands = { async executeCommand(command, uri, options) {
      if (command === 'sweetiebot.queueCommit') return undefined;
      if (command === 'sweetiebot.checkCommitLimits') return true;
      if (command === 'sweetiebot.beginCommit') {
        events.push('begin');
        assert.equal(options.waitForPush, true);
        return 'token';
      }
      if (command === 'sweetiebot.endCommit') {
        events.push(['end', options.gateToken, options.pushed]);
        return;
      }
      throw new Error(command);
    } };
    const errors = [];
    const context = vm.createContext({
      repository, commands, configuration: { getValue() { return 'push'; } },
      notifications: { error(error) { errors.push(error); } }
    });
    vm.runInContext(snippet + '\nscmToolkitGuardCommit(repository, commands, configuration, notifications);', context);
    await repository.commit('message', {});
    assert.deepEqual(events, ['begin', 'commit', 'push'], 'Commit finishes, but gate remains pending during push');
    finishPush();
    for (let tries = 0; tries < 20 && !events.some(item => Array.isArray(item)); tries++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.deepEqual(events.at(-1), ['end', 'token', !pushFails]);
    assert.equal(errors.length, pushFails ? 1 : 0);
  }
  // Confirm immediate feedback, no premature success, and cancellation cleanup.
  {
    const events = [];
    let allowPreflight, finishCommit;
    const repository = {
      rootUri: { fsPath: '/tmp/repo' },
      async commit() {
        events.push('git commit');
        await new Promise(resolve => { finishCommit = resolve; });
      }
    };
    const commands = { async executeCommand(command) {
      events.push(command);
      if (command === 'sweetiebot.checkCommitLimits') {
        return new Promise(resolve => { allowPreflight = resolve; });
      }
    } };
    const notifications = {
      notify(options) {
        assert.equal(options.severity, 1);
        assert.equal(options.message, 'Generating commit message');
        events.push('progress');
        return { close() { events.push('closed'); } };
      },
      info(message) { events.push(message); }
    };
    const context = vm.createContext({
      repository, commands, notifications, configuration: { getValue() { return 'none'; } }
    });
    vm.runInContext(
      snippet + '\nscmToolkitGuardCommit(repository, commands, configuration, notifications, { aiCommit: true });',
      context
    );
    const committing = repository.commit('', {});
    assert.deepEqual(events, ['progress', 'sweetiebot.checkCommitLimits'],
      'Notification must be queued before any asynchronous work');
    allowPreflight(true);
    await new Promise(resolve => setImmediate(resolve));
    assert(events.includes('git commit'), 'The normal commit starts after preflight');
    assert(!events.includes('Commit created.'), 'Never announce success before Git finishes');
    finishCommit();
    await committing;
    assert.deepEqual(events.slice(-2),
      ['closed', 'sweetiebot.endCommit'],
      'Completion closes progress quietly');
    assert(!events.includes('Commit created.'));

    const successes = events.filter(event => event === 'Commit created.').length;
    const rejected = repository.commit('', {});
    allowPreflight(false);
    await rejected;
    assert.equal(events.at(-1), 'closed', 'Canceling preflight closes progress');
    assert.equal(events.filter(event => event === 'Commit created.').length, successes,
      'Canceled commits must not report success');
  }
  {
    const events = [];
    const repository = {
      rootUri: { fsPath: '/tmp/repo' },
      async commit() { throw new Error('Hook failed'); }
    };
    const commands = { async executeCommand() { return true; } };
    const notifications = {
      notify() { events.push('progress'); return { close() { events.push('closed'); } }; },
      info() { events.push('success'); }
    };
    const context = vm.createContext({
      repository, commands, notifications, configuration: { getValue() { return 'none'; } }
    });
    vm.runInContext(
      snippet + '\nscmToolkitGuardCommit(repository, commands, configuration, notifications, { aiCommit: true });',
      context
    );
    await assert.rejects(repository.commit('', {}), /Hook failed/);
    assert.deepEqual(events, ['progress', 'closed'],
      'A failed Git commit must close progress without claiming success');
  }
  {
    let nativeCommits = 0, nativePushes = 0, duplicateChecks = 0;
    const requests = [];
    const repository = {
      rootUri: { fsPath: '/tmp/repo' },
      async commit() { nativeCommits++; }, async push() { nativePushes++; }
    };
    const context = vm.createContext({ repository,
      commands: { async executeCommand(id, root, request) {
        if (id === 'sweetiebot.checkCommitLimits') {
          duplicateChecks++;
          return true;
        }
        assert.equal(id, 'sweetiebot.queueCommit');
        requests.push(request);
        return { queued: true };
      } },
      configuration: { getValue(key) { return key === 'scmToolkit.durableBackgroundCommits' ? true : 'push'; } },
      notifications: { notify() { return { close() {} }; } }
    });
    vm.runInContext(snippet + '\nscmToolkitGuardCommit(repository, commands, configuration, notifications, { aiCommit: true });', context);
    await repository.commit('', {});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].push, true);
    assert.equal(requests[0].message, '');
    assert.equal(nativeCommits, 0, 'the saved worker owns the commit');
    assert.equal(nativePushes, 0, 'the saved worker owns publication');
    await repository.commit('', { all: true });
    assert.equal(requests.length, 2, 'smart Commit All also uses the immediate placeholder worker');
    assert.equal(requests[1].all, true);
    assert.equal(nativeCommits, 0);
    assert.equal(duplicateChecks, 0,
      'durable Commit and Commit All perform their single inspection inside the queue');
  }
  for (const outcome of [
    { result: { cancelled: true }, allowed: true, expectedCommits: 0, expectedChecks: 0 },
    { result: { queued: false, preflightApproved: true, stagedTree: 'a'.repeat(40) },
      allowed: true, expectedCommits: 1, expectedChecks: 1, expectedTree: 'a'.repeat(40) },
    { result: { queued: false, preflightApproved: true, stagedTree: 'a'.repeat(40) },
      allowed: false, expectedCommits: 0, expectedChecks: 1, expectedTree: 'a'.repeat(40) },
    { result: { queued: false }, allowed: true, expectedCommits: 1, expectedChecks: 1 },
    { result: { queued: false }, allowed: false, expectedCommits: 0, expectedChecks: 1 },
  ]) {
    let nativeCommits = 0, checks = 0;
    const calls = [];
    const repository = {
      rootUri: { fsPath: '/tmp/repo' },
      async commit() { nativeCommits++; }, async push() {}
    };
    const context = vm.createContext({
      repository,
      commands: { async executeCommand(id, _uri, options) {
        calls.push(id);
        if (id === 'sweetiebot.queueCommit') return outcome.result;
        if (id === 'sweetiebot.checkCommitLimits') {
          checks++;
          assert.equal(options?.approvedTree, outcome.expectedTree,
            'the direct path can reuse only the queue-approved staged tree');
          return outcome.allowed;
        }
        if (id === 'sweetiebot.beginCommit' || id === 'sweetiebot.endCommit') return undefined;
        throw new Error('Unexpected command: ' + id);
      } },
      configuration: { getValue(key) {
        return key === 'scmToolkit.durableBackgroundCommits' ? true : 'none';
      } },
      notifications: { notify() { return { close() {} }; } }
    });
    vm.runInContext(snippet + '\nscmToolkitGuardCommit(repository, commands, configuration, notifications);', context);
    await repository.commit('Message', {});
    assert.equal(nativeCommits, outcome.expectedCommits,
      'canceled checks never fall through to unsafe direct Git commits');
    assert.equal(checks, outcome.expectedChecks,
      'only declined queues consult the shared inspector for cached or new approval');
    assert.equal(calls[0], 'sweetiebot.queueCommit',
      'durable path does not check unstaged changes before the queue stages them');
  }
  console.log('Commit guard tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
