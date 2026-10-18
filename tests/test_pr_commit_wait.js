'use strict';
const assert = require('node:assert/strict');
const { pendingPRCommits } = require('../efs/pr_commit_wait');

(async () => {
  const progress = [];
  const vscode = {
    Uri: { joinPath: () => ({ fsPath: '/extension/background_commit.py' }) },
    ProgressLocation: { Notification: 1 },
    window: { withProgress(options, task) { progress.push(options); return task(); } },
  };
  const root = { fsPath: '/repo' };
  const context = {};
  let current = {};
  let pauses = 0;
  const dependencies = { status: async () => current, pause: async () => {
    pauses++;
    current = pauses === 1 ? { id: 'job', phase: 'pushing', titleJobs: [] } : {};
  } };
  assert.equal(await pendingPRCommits(vscode, context, root, dependencies), undefined);
  assert.equal(progress.length, 0);
  current = { id: 'job', phase: 'generating', titleJobs: ['job'] };
  const wait = await pendingPRCommits(vscode, context, root, dependencies);
  assert.equal(pauses, 0, 'Discover pending work without delaying window creation');
  await wait();
  assert.equal(pauses, 2, 'Wait for publication as well as finalized local titles');
  current = { id: 'job', phase: 'blocked', error: 'Push failed' };
  await assert.rejects((await pendingPRCommits(vscode, context, root, dependencies))(), /Push failed/);
  current = null;
  await assert.rejects(pendingPRCommits(vscode, context, root, dependencies), /Could not check/);
  current = { id: 'job', phase: 'generating' };
  dependencies.pause = async () => { current = null; };
  await assert.rejects((await pendingPRCommits(vscode, context, root, dependencies))(), /Could not check/);
  console.log('PR commit naming, push, and failure wait checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
