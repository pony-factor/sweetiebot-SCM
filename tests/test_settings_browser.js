'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function run() {
  const children = [], calls = [], errors = [], updates = [];
  const state = new Map();
  const workspaceState = new Map();
  let available = true, failOpen = false;
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration(root) {
      return {
        get(key, fallback) {
          if (root === 'scmToolkit' && key === 'openPanelOnStartup') return false;
          if (root === 'scmToolkit' && key === 'autoPublishNewBranches') return true;
          if (root === 'scmToolkit' && key === 'messagePlaceholder') return 'Commit here';
          if (root === 'scmToolkit' && key === 'commitButtonLabel') return 'Commit';
          if (root === 'scmToolkit' && key === 'commitAndSendButtonLabel') return 'Commit + Push';
          if (root === 'scmToolkit.workspaceSearch' && key === 'resultLimit') return 35;
          return fallback;
        },
        async update(key, value, target) { updates.push({root, key, value, target}); }
      };
    } },
    Uri: { joinPath: (_, file) => ({ fsPath: `/extension/${file}` }) },
    window: { showErrorMessage: message => errors.push(message) },
    commands: {
      async getCommands() { return available ? ['workbench.action.browser.open'] : []; },
      async executeCommand(id, options) {
        calls.push({ id, options });
        if (failOpen) throw new Error('Browser failed');
      }
    }
  };
  const sandbox = vm.createContext({
    module: { exports: {} }, process, URL, setTimeout, clearTimeout,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:os') return { homedir: () => '/stable-home' };
      if (name === './python_runtime') {
        return {
          resolvePythonExecutable: () => '/resolved/python3',
          pythonLaunchError: error => error
        };
      }
      if (name !== 'child_process') return {};
      return { spawn(executable, args, options) {
        assert.equal(executable, '/resolved/python3');
        assert.deepEqual(Array.from(args).slice(0, 3), [
          '/extension/configurator.py', '--no-browser', '--vscode-settings'
        ]);
        const current = JSON.parse(args[3]);
        assert.equal(current.vscodeSettings.openPanelOnStartup, false);
        assert.equal(current.vscodeSettings.autoPublishNewBranches, true);
        assert.equal(current.vscodeSettings.messagePlaceholder, 'Commit here');
        assert.equal(current.vscodeSettings.commitButtonLabel, 'Commit');
        assert.equal(current.vscodeSettings.commitAndSendButtonLabel, 'Commit + Push');
        assert.equal(current.workspaceSearch.resultLimit, 35);
        assert.equal(current.editorSettings['inlineSuggest.enabled'], true);
        assert.equal(current.gitSettings.postCommitCommand, 'none');
        assert.equal(options.cwd, '/stable-home', 'The settings server must outlive extension directory replacement');
        assert.equal(options.stdio[1], 'pipe');
        const child = new EventEmitter();
        child.spawnArgs = Array.from(args);
        child.exitCode = null;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout.setEncoding = child.stderr.setEncoding = () => {};
        child.kill = () => { child.killed = true; };
        children.push(child);
        return child;
      } };
    },
    context: {
      extensionUri: {},
      extensionPath: '/extension',
      globalState: {
        get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
        async update(key, value) { state.set(key, value); }
      },
      workspaceState: {
        get(key, fallback) { return workspaceState.has(key) ? workspaceState.get(key) : fallback; },
        async update(key, value) { workspaceState.set(key, value); }
      }
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../efs/extension.js'), 'utf8'), sandbox);
  const open = () => vm.runInContext('openSettings(context)', sandbox);
  const tick = () => new Promise(resolve => setImmediate(resolve));

  available = false;
  await open();
  assert.equal(children.length, 0);
  assert.match(errors.pop(), /Update VS Code/);
  available = true;
  await open();
  await open();
  assert.equal(children.length, 1, 'Repeated clicks during startup must not start another server');
  const url = 'http://127.0.0.1:49152/?token=test';
  const line = JSON.stringify({ url });
  children[0].stdout.emit('data', '{"url":"https://example.com"}\n' + line.slice(0, 10));
  assert.equal(calls.length, 0);
  children[0].stdout.emit('data', line.slice(10) + '\n');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'workbench.action.browser.open');
  assert.equal(calls[0].options.url, url);
  assert.equal(calls[0].options.openToSide, false);
  assert.equal(calls[0].options.reuseUrlFilter, url);
  assert.equal(workspaceState.get('scmToolkit.settingsSessionUrl'), url);
  assert.equal(state.has('scmToolkit.settingsSessionUrl'), false, 'New sessions must not overwrite another workspace URL');
  assert.equal(state.get('scmToolkit.settingsPageOpened'), true);
  await open();
  assert.equal(calls.length, 2, 'Repeated click must refocus the native browser');
  assert.equal(children.length, 1);
  const saved = {embeddingModel: 'custom:embed', chatModel: 'custom:chat', askOllama: true};
  children[0].stdout.emit('data', JSON.stringify({
    workspaceSearch: saved,
    vscodeSettings: {
      openPanelOnStartup: true,
      autoPublishNewBranches: true,
      messagePlaceholder: 'Type a commit message',
      commitButtonLabel: 'Save',
      commitAndSendButtonLabel: 'Save + Push'
    },
    editorSettings: {'inlineSuggest.enabled': false},
    gitSettings: {postCommitCommand: 'push'}
  }) + '\n');
  await tick();
  assert.deepEqual(updates, [
    ...Object.entries(saved).map(([key, value]) => ({
      root: 'scmToolkit.workspaceSearch', key, value, target: 1
    })),
    {root: 'scmToolkit', key: 'openPanelOnStartup', value: true, target: 1},
    {root: 'scmToolkit', key: 'autoPublishNewBranches', value: true, target: 1},
    {root: 'scmToolkit', key: 'messagePlaceholder', value: 'Type a commit message', target: 1},
    {root: 'scmToolkit', key: 'commitButtonLabel', value: 'Save', target: 1},
    {root: 'scmToolkit', key: 'commitAndSendButtonLabel', value: 'Save + Push', target: 1},
    {root: 'editor', key: 'inlineSuggest.enabled', value: false, target: 1},
    {root: 'git', key: 'postCommitCommand', value: 'push', target: 1}
  ]);
  assert.equal(calls.length, 2, 'Saving settings must apply them without reopening the browser');
  children[0].exitCode = 0;
  children[0].emit('exit', 0);
  await open();
  assert.equal(children.length, 2, 'A finished settings session must be restartable');
  assert.deepEqual(Array.from(children[1].spawnArgs).slice(-6), ['--parent-pid', String(process.pid), '--port', '49152', '--token', 'test']);
  failOpen = true;
  children[1].stdout.emit('data', line + '\n');
  await tick();
  assert.equal(children[1].killed, true);
  assert.match(errors.pop(), /Integrated Browser/);
  failOpen = false;
  children[1].exitCode = 0;
  children[1].emit('exit', 0);
  await open();
  const shutdown = sandbox.module.exports.deactivate();
  assert.equal(children[2].killed, true, 'Closing the extension must stop its server');
  children[2].emit('exit', 0);
  await shutdown;
  assert.equal(errors.length, 0);
  console.log('Settings native browser checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
