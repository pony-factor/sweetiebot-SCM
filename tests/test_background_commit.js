'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function run() {
  const commands = new Map(), preparations = [], jobs = [], events = [];
  let poll;
  let status = {};
  const notices = [], progress = [], completed = [], errors = [];
  const errorActions = [], details = [];
  let nextChoice;
  const noticeTimers = [];
  let resumes = 0;
  const root = { scheme: 'file', fsPath: '/repo' };
  const repository = {
    rootUri: root,
    state: { indexChanges: [], mergeChanges: [] },
    async status() {},
  };
  const sandbox = vm.createContext({
    module: { exports: {} },
    setTimeout(callback, delay) {
      if (delay !== 1000) return setTimeout(callback, delay);
      const timer = { callback, cancelled: false };
      noticeTimers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (noticeTimers.includes(timer)) timer.cancelled = true;
      else clearTimeout(timer);
    },
    setInterval(callback) { poll = callback; return 1; }, clearInterval() {},
    require(name) {
      if (name === './python_runtime') return { resolvePythonExecutable: () => 'python', pythonLaunchError: e => e };
      assert.equal(name, 'node:child_process');
      return { execFile(_exe, _args, _options, callback) { callback(null, JSON.stringify(status)); }, spawn(_exe, args) {
        if (args.includes('--resume')) resumes++;
        const child = new EventEmitter();
        child.unref = () => {};
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new EventEmitter();
        child.stdin.end = input => {
          if (args.includes('--request-push')) {
            child.stdout.emit('data', JSON.stringify({ queued: !!status.id }));
            child.emit('close', 0);
            return;
          }
          assert(args.includes('--enqueue'));
          assert(repository.state.indexChanges.length, 'prepare before enqueueing');
          jobs.push(JSON.parse(input)); events.push('enqueue');
          child.stdout.emit('data', JSON.stringify({ queued: true, id: String(jobs.length) }));
          child.emit('close', 0);
        };
        return child;
      } };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../efs/background_commit'), 'utf8'), sandbox);
  const vscode = {
    Uri: { from: uri => uri, joinPath: (_uri, name) => ({ fsPath: '/extension/' + name }) },
    extensions: { getExtension: () => ({ async activate() { return { getAPI: () => ({ repositories: [repository], getRepository: () => repository }) }; } }) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    ProgressLocation: { Notification: 15 },
    window: {
      showInformationMessage(message) { notices.push(message); },
      async showErrorMessage(message, ...actions) {
        errors.push(message); errorActions.push(actions);
        const choice = nextChoice; nextChoice = undefined; return choice;
      },
      createOutputChannel() {
        return { appendLine(text) { details.push(text); }, show() {}, dispose() {} };
      },
      async withProgress(options, task) {
        progress.push(options);
        await task();
        completed.push(options);
      }
    },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return { dispose() {} }; },
      async executeCommand(id, uri, options) {
        assert.equal(uri, root);
        if (id === 'sweetiebot.prepareCodexCommit') {
          preparations.push(options); events.push('stage');
          repository.state.indexChanges = ['prepared'];
        } else { assert.equal(id, 'sweetiebot.checkCommitLimits'); events.push('limits'); return true; }
      }
    }
  };
  sandbox.module.exports.registerBackgroundCommit(vscode, { extensionUri: root, subscriptions: [] });
  const push = commands.get('sweetiebot.queuePush');
  assert.equal((await push(root)).queued, false);
  assert.deepEqual(notices, [], 'ordinary pushes do not create a waiting notice');
  status = { id: 'older', phase: 'generating' };
  assert.equal((await push(root)).queued, true);
  assert.equal(notices.pop(), 'Commit message generation is in progress. Your changes will be pushed as soon as it completes.');
  status = {};
  const commit = commands.get('sweetiebot.queueCommit');
  const notQueued = await commit(root, { message: 'Manual', onlyIfPending: true });
  assert.equal(notQueued.queued, false);
  assert.deepEqual(events, [], 'checking an empty queue never stages or commits');

  await commit(root, { message: 'Test' });
  assert.deepEqual(events, ['stage', 'limits', 'enqueue']);
  await commit(root, { message: 'Staged selection' });
  assert.equal(preparations.length, 1, 'staged-only commits preserve unstaged changes');
  await commit(root, { message: 'Tracked selection', all: 'tracked' });
  assert.equal(preparations[1].all, 'tracked');
  status = { id: 'older', phase: 'generating', titleJobs: ['older'] };
  const manualMessage = '🧪 Manual subject\n\nCo-authored-by: Codex <noreply@openai.com>';
  await commit(root, { message: manualMessage, onlyIfPending: true });
  assert.equal(jobs.at(-1).message, manualMessage);
  status = {};
  repository.state.mergeChanges = ['conflict'];
  await assert.rejects(commit(root), /Resolve conflicts/);
  assert.equal(jobs.length, 4, 'conflicts never stage or enqueue');
  repository.state.mergeChanges = [];
  await commit(root);
  await commit(root);
  assert.equal(progress.length, 1, 'parallel title jobs share the original generation box');
  assert.equal(progress[0].title, 'Generating commit message asynchronously');
  assert.equal(completed.length, 0, 'enqueue acknowledgement does not close generation');
  assert.equal(noticeTimers.length, 1, 'parallel title jobs share one expiry timer');
  noticeTimers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed.length, 1, 'notification closes after one second while generation continues');
  status = { id: '1', phase: 'pushing', titleJobs: ['5'] };
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed.length, 1, 'pending title jobs do not reopen the expired notification');
  assert.equal(progress.length, 1, 'polling must not show the same notification again');
  status = { id: '1', phase: 'pushing', titleJobs: [] };
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed.length, 1, 'title application closes progress without waiting for push');
  assert.equal(noticeTimers[0].cancelled, true, 'finished jobs clean up their expiry timer');
  status = {};
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices, ['repo: Push is pending and will retry automatically.'],
    'no local-save or completion notifications');
  const beforeRecovery = resumes;
  status = { id: 'old', phase: 'blocked', recoverable: true, titleJobs: ['old'],
    error: 'The branch advanced; message finalization was paused.' };
  poll();
  await new Promise(resolve => setImmediate(resolve));
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumes, beforeRecovery + 1, 'resume a verified queue once per recovery transition');
  assert.deepEqual(errors, [], 'expected queued descendants do not produce a paused error');
  status = { ...status, recoverable: false, titleJobs: [] };
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1, 'a genuine branch mismatch remains visible');
  status = { id: 'rejected-push', phase: 'blocked', titleJobs: [], branch: 'refs/heads/hoofar',
    conflictPaths: ['Sources/RepoLauncher.swift', 'Repository Launcher.app/Contents/MacOS/RepositoryLauncher'],
    error: 'Push rejected: local and remote changes have merge conflicts.' };
  nextChoice = 'View conflicting files';
  poll();
  await new Promise(resolve => setImmediate(resolve));
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 2, 'a rejected push produces one actionable error');
  assert.equal(errors[1], 'repo (hoofar): Push blocked by merge conflicts in 2 files. Lindsey could not sync this branch.');
  assert.deepEqual(errorActions[1], ['View conflicting files', 'Retry sync and push', 'Stop background push']);
  assert(details[0].includes('Repository: /repo\nBranch: hoofar'));
  assert(details[0].includes('  • Sources/RepoLauncher.swift'));
  assert(details[0].includes('  • Repository Launcher.app/Contents/MacOS/RepositoryLauncher'));
  const legacy = sandbox.module.exports.blockedNotification('/work/mobli', { error: status.error });
  assert.equal(legacy.message, 'mobli: Push blocked by merge conflicts. Lindsey could not sync this branch.');
  assert.equal(progress.length, 2, 'a separate generation batch gets a new notification');
  assert.equal(completed.length, 2, 'jobs finishing early close their notification immediately');
  assert.equal(noticeTimers[1].cancelled, true, 'early completion cancels the one-second timer');
  console.log('Background smart commit and notification lifecycle checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
