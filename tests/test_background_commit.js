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
  let limitsAllowed = true, declineEnqueue = false;
  let staleEnqueueCount = 0, validatedTree = 'a'.repeat(40);
  const snapshotFor = tree => ({
    version: 1, tree, parent: '', files: [{ path: 'changed.txt', size: 12 }],
    diff: { totalBytes: 30, totalLines: 2, sections: [{ bytes: 30, lines: 2 }] },
    approvedWarnings: []
  });
  const notices = [], progress = [], completed = [], errors = [];
  const titleContexts = [];
  const errorActions = [], details = [];
  let nextChoice;
  let merged = null;
  const mergedWarnings = [];
  const noticeTimers = [];
  let resumes = 0;
  const root = { scheme: 'file', fsPath: '/repo' };
  let statusCalls = 0;
  const repository = {
    rootUri: root,
    state: { indexChanges: [], mergeChanges: [] },
    async status() { statusCalls++; },
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
      if (name === './merged_branch') return {
        mergedBranchStatus: async () => merged,
        warnMergedBranch: async (_vscode, _repository, info) => { mergedWarnings.push(info); return false; }
      };
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
          events.push('enqueue');
          if (staleEnqueueCount > 0) {
            staleEnqueueCount--;
            validatedTree = 'b'.repeat(40);
            child.stderr.emit('data',
              'Staged changes changed after the commit-size check. Review and retry.');
            child.emit('close', 1);
            return;
          }
          if (declineEnqueue) {
            child.stdout.emit('data', JSON.stringify({ queued: false }));
            child.emit('close', 0);
            return;
          }
          jobs.push(JSON.parse(input));
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
        if (id === 'setContext') {
          assert.equal(uri, 'sweetiebot.pushPending');
          titleContexts.push(options);
          return;
        }
        assert.equal(uri, root);
        if (id === 'sweetiebot.prepareCodexCommit') {
          preparations.push(options); events.push('stage');
          repository.state.indexChanges = ['prepared'];
        } else {
          assert.equal(id, 'sweetiebot.checkCommitLimits');
          assert.equal(options.captureTree, true,
            'durable commits inspect and pin their exact final staged tree');
          events.push('limits');
          return {
            approved: limitsAllowed, stagedTree: validatedTree,
            validatedSnapshot: snapshotFor(validatedTree)
          };
        }
      }
    }
  };
  sandbox.module.exports.registerBackgroundCommit(vscode, { extensionUri: root, subscriptions: [] });
  const push = commands.get('sweetiebot.queuePush');
  assert.equal((await push(root)).queued, false);
  assert.deepEqual(notices, [], 'ordinary pushes do not create a waiting notice');
  status = { id: 'older', phase: 'generating' };
  assert.equal((await push(root)).queued, true);
  assert.equal(titleContexts.at(-1), true, 'title shows Pushing while a queued push waits for naming');
  assert.equal(notices.pop(), 'Commit message generation is in progress. Your changes will be pushed as soon as it completes.');
  status = {};
  const commit = commands.get('sweetiebot.queueCommit');
  merged = { branch: 'old', number: 61, defaultBranch: 'main', remote: 'origin' };
  assert.equal((await push(root)).cancelled, true);
  assert.equal((await commit(root, { push: true })).cancelled, true);
  assert.equal(mergedWarnings.length, 2);
  assert.deepEqual(events, [], 'merged-branch warning happens before staging or enqueueing');
  merged = null;
  const notQueued = await commit(root, { message: 'Manual', onlyIfPending: true });
  assert.equal(notQueued.queued, false);
  assert.deepEqual(events, [], 'checking an empty queue never stages or commits');

  // Once final staged content is known, rejection must stop *before* enqueue,
  // snapshotting or background Ollama title generation.
  limitsAllowed = false;
  repository.state.indexChanges = ['staged'];
  const denied = await commit(root, { message: 'Oversize' });
  assert.equal(denied.cancelled, true);
  assert.deepEqual(events, ['limits']);
  assert.equal(jobs.length, 0, 'a rejected size preflight cannot enter the worker');
  limitsAllowed = true;
  repository.state.indexChanges = [];

  const initialStatusCalls = statusCalls;
  await commit(root, { message: 'Test' });
  assert.deepEqual(events, ['limits', 'stage', 'limits', 'enqueue']);
  assert.equal(statusCalls - initialStatusCalls, 2,
    'queue refreshes once before preflight and once after the local commit');
  assert.equal(preparations[0].statusFresh, true,
    'preparation reuses the verified Git state');
  assert.equal(jobs[0].expectedTree, 'a'.repeat(40),
    'the approved staged tree must reach the Python commit worker');
  assert.deepEqual(jobs[0].validatedSnapshot, snapshotFor('a'.repeat(40)),
    'the durable worker must reuse inspected blob sizes, diff counts, and approved warnings');
  await commit(root, { message: 'Staged selection' });
  assert.equal(preparations.length, 1, 'staged-only commits preserve unstaged changes');
  await commit(root, { message: 'Tracked selection', all: 'tracked' });
  assert.equal(preparations[1].all, 'tracked');

  declineEnqueue = true;
  const jobsBeforeDecline = jobs.length;
  const declined = await commit(root, { message: '' });
  assert.equal(declined.queued, false);
  assert.equal(declined.preflightApproved, true,
    'the queue can reuse an approved size check when the Python worker declines');
  assert.equal(declined.stagedTree, validatedTree,
    'the direct fallback must compare the approved tree before reusing its result');
  assert.equal(jobs.length, jobsBeforeDecline,
    'a declined background job leaves Git commitment to the direct path');
  declineEnqueue = false;
  assert.equal(notQueued.preflightApproved, undefined,
    'onlyIfPending exits before preflight and cannot claim approval');

  const beforeRetry = events.length;
  const beforeJobs = jobs.length;
  staleEnqueueCount = 1;
  await commit(root, { message: 'Retry after concurrent staging' });
  assert.deepEqual(events.slice(beforeRetry), ['limits', 'enqueue', 'limits', 'enqueue'],
    'reinspect the changed staged tree before queueing the final local commit');
  assert.equal(jobs.length, beforeJobs + 1,
    'a changed selection must create exactly one local background job');
  assert.equal(jobs.at(-1).expectedTree, 'b'.repeat(40),
    'the retried job must use the newly approved tree, not the stale hash');
  assert.equal(jobs.at(-1).validatedSnapshot.tree, 'b'.repeat(40),
    'a retried job must refresh its approved metadata along with the staged tree');

  status = { id: 'older', phase: 'generating', titleJobs: ['older'] };
  const manualMessage = '🧪 Manual subject\n\nCo-authored-by: Codex <noreply@openai.com>';
  await commit(root, { message: manualMessage, onlyIfPending: true });
  assert.equal(jobs.at(-1).message, manualMessage);
  status = {};
  repository.state.mergeChanges = ['conflict'];
  const beforeConflict = jobs.length;
  await assert.rejects(commit(root), /Resolve conflicts/);
  assert.equal(jobs.length, beforeConflict, 'conflicts never stage or enqueue');
  repository.state.mergeChanges = [];
  await commit(root, { push: true });
  assert.equal(titleContexts.at(-1), true, 'Commit & Push sets the title before the next status poll');
  await commit(root);
  assert.equal(progress.length, 1, 'parallel title jobs share the original generation box');
  assert.equal(progress[0].title, 'Generating commit message asynchronously');
  assert.equal(completed.length, 0, 'enqueue acknowledgement does not close generation');
  assert.equal(noticeTimers.length, 1, 'parallel title jobs share one expiry timer');
  noticeTimers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed.length, 1, 'notification closes after one second while generation continues');
  status = { id: '1', phase: 'pushing', titleJobs: ['5'], pushPending: true };
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed.length, 1, 'pending title jobs do not reopen the expired notification');
  assert.deepEqual(notices, [], 'entering the pushing phase is not a notification-worthy failure');
  assert.equal(progress.length, 1, 'polling must not show the same notification again');
  status = { id: '1', phase: 'pushing', titleJobs: [], pushPending: true };
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed.length, 1, 'title application closes progress without waiting for push');
  assert.equal(noticeTimers[0].cancelled, true, 'finished jobs clean up their expiry timer');
  assert.equal(titleContexts.at(-1), true, 'Pushing survives title generation finishing');
  status = {};
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(titleContexts.at(-1), false, 'empty queue clears Pushing');
  assert.deepEqual(notices, [],
    'ordinary background pushes, retries, and completion never show informational notifications');
  // A worker can keep retrying after VS Code exits. Reconnecting to its
  // already-running pushing phase must not reopen a misleading notification.
  status = { id: 'resumed-push', phase: 'pushing', titleJobs: [], pushPending: true };
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices, [], 'reattaching to a pending push stays silent');
  assert.equal(titleContexts.at(-1), true, 'pending push remains reflected in title context');
  status = {};
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(titleContexts.at(-1), false, 'title context clears when resumed push finishes');
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
  assert.equal(titleContexts.at(-1), false, 'blocked jobs do not leave Pushing behind');
  status = { id: 'rejected-push', phase: 'blocked', titleJobs: [], branch: 'refs/heads/hoofar',
    conflictPaths: ['Sources/RepoLauncher.swift', 'Repository Launcher.app/Contents/MacOS/RepositoryLauncher'],
    error: 'Push rejected: local and remote changes have merge conflicts.' };
  nextChoice = 'View conflicting files';
  poll();
  await new Promise(resolve => setImmediate(resolve));
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 2, 'a rejected push produces one actionable error');
  assert.equal(errors[1], 'Sweetiebot: Push blocked by merge conflicts in 2 files. Lindsey could not sync this branch.');
  assert.deepEqual(errorActions[1], ['View conflicting files', 'Retry sync and push', 'Stop background push']);
  assert(details[0].includes('Repository: /repo\nBranch: hoofar'));
  assert(details[0].includes('  • Sources/RepoLauncher.swift'));
  assert(details[0].includes('  • Repository Launcher.app/Contents/MacOS/RepositoryLauncher'));
  const legacy = sandbox.module.exports.blockedNotification('/work/mobli', { error: status.error });
  assert.equal(legacy.message, 'Sweetiebot: Push blocked by merge conflicts. Lindsey could not sync this branch.');
  assert.equal(progress.length, 2, 'a separate generation batch gets a new notification');
  assert.equal(completed.length, 2, 'jobs finishing early close their notification immediately');
  assert.equal(noticeTimers[1].cancelled, true, 'early completion cancels the one-second timer');
  console.log('Background smart commit and notification lifecycle checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
