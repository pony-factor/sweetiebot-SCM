'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function run() {
  const commands = new Map(), preparations = [], jobs = [], events = [];
  const root = { scheme: 'file', fsPath: '/repo' };
  const repository = {
    state: { indexChanges: [], mergeChanges: [] },
    async status() {},
  };
  const sandbox = vm.createContext({
    module: { exports: {} }, setTimeout, clearTimeout,
    setInterval() { return 1; }, clearInterval() {},
    require(name) {
      if (name === './python_runtime') return { resolvePythonExecutable: () => 'python', pythonLaunchError: e => e };
      assert.equal(name, 'node:child_process');
      return { spawn(_exe, args) {
        const child = new EventEmitter();
        child.unref = () => {};
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new EventEmitter();
        child.stdin.end = input => {
          assert(args.includes('--enqueue'));
          assert(repository.state.indexChanges.length, 'prepare before enqueueing');
          jobs.push(JSON.parse(input)); events.push('enqueue');
          child.stdout.emit('data', JSON.stringify({ queued: true }));
          child.emit('close', 0);
        };
        return child;
      } };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../efs/background_commit'), 'utf8'), sandbox);
  const vscode = {
    Uri: { from: uri => uri, joinPath: (_uri, name) => ({ fsPath: '/extension/' + name }) },
    extensions: { getExtension: () => ({ async activate() { return { getAPI: () => ({ repositories: [], getRepository: () => repository }) }; } }) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { showInformationMessage() {} },
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
  const commit = commands.get('sweetiebot.queueCommit');
  await commit(root, { message: 'Test' });
  assert.deepEqual(events, ['stage', 'limits', 'enqueue']);
  await commit(root, { message: 'Staged selection' });
  assert.equal(preparations.length, 1, 'staged-only commits preserve unstaged changes');
  await commit(root, { message: 'Tracked selection', all: 'tracked' });
  assert.equal(preparations[1].all, 'tracked');
  repository.state.mergeChanges = ['conflict'];
  await assert.rejects(commit(root), /Resolve conflicts/);
  assert.equal(jobs.length, 3, 'conflicts never stage or enqueue');
  console.log('Background smart commit command checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
