'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function run() {
  const children = [], calls = [], errors = [], updates = [];
  let managedActivityStops = 0;
  const state = new Map();
  const workspaceState = new Map();
  let available = true, failOpen = false;
  let extensionAutoUpdate = 'off';
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration(root) {
      return {
        get(key, fallback) {
          if (root === 'update' && key === 'mode') return 'start';
          if (root === 'extensions' && key === 'autoUpdate') return extensionAutoUpdate;
          if (root === 'extensions' && key === 'autoCheckUpdates') return false;
          if (root === 'scmToolkit' && key === 'openPanelOnStartup') return false;
          if (root === 'scmToolkit' && key === 'autoPublishNewBranches') return true;
          if (root === 'scmToolkit' && key === 'automaticWorkspaceCleanup') return true;
          if (root === 'scmToolkit' && key === 'messagePlaceholder') return 'Commit here';
          if (root === 'scmToolkit' && key === 'commitButtonLabel') return 'Commit';
          if (root === 'scmToolkit' && key === 'commitAndSendButtonLabel') return 'Commit + Push';
          if (root === 'scmToolkit' && key === 'hideIncomingSyncArrow') return true;
          if (root === 'scmToolkit' && key === 'hideOutgoingSyncArrow') return false;
          if (root === 'scmToolkit' && key === 'incomingSyncLabel') return 'From origin';
          if (root === 'scmToolkit' && key === 'outgoingSyncLabel') return 'To origin';
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
      if (name === 'node:path') return require('node:path');
      if (name === './codex/kefania_close_position') return require('../extension/codex/kefania_close_position');
      if (name === './ui/extension_cache') return { invalidateUserExtensionCache() {} };
      if (name === './branches/workspace_activity') {
        return { stopManagedWindowActivity: async () => { managedActivityStops++; } };
      }
      if (name === './ui/python_runtime') {
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
        assert.equal(current.vscodeSettings.automaticWorkspaceCleanup, true);
        assert.equal(current.vscodeSettings.messagePlaceholder, 'Commit here');
        assert.equal(current.vscodeSettings.commitButtonLabel, 'Commit');
        assert.equal(current.vscodeSettings.commitAndSendButtonLabel, 'Commit + Push');
        assert.equal(current.vscodeSettings.hideIncomingSyncArrow, true);
        assert.equal(current.vscodeSettings.hideOutgoingSyncArrow, false);
        assert.equal(current.vscodeSettings.incomingSyncLabel, 'From origin');
        assert.equal(current.vscodeSettings.outgoingSyncLabel, 'To origin');
        assert.equal(current.appUpdateSettings.mode, 'start');
        assert.equal(current.extensionUpdateSettings.autoUpdate, ![false, 'off'].includes(extensionAutoUpdate));
        assert.equal(current.extensionUpdateSettings.autoCheckUpdates, false);
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
      globalStorageUri: { fsPath: '/stable-home/Code/User/globalStorage/pony-factor.sweetiebot-scm' },
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
  vm.runInContext(fs.readFileSync(require.resolve('../extension/extension.js'), 'utf8'), sandbox);
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
      automaticWorkspaceCleanup: false,
      messagePlaceholder: 'Type a commit message',
      commitButtonLabel: 'Save',
      commitAndSendButtonLabel: 'Save + Push',
      hideIncomingSyncArrow: false,
      hideOutgoingSyncArrow: true,
      incomingSyncLabel: 'Pulled',
      outgoingSyncLabel: 'Pushed'
    },
    appUpdateSettings: {mode: 'manual'},
    extensionUpdateSettings: {autoCheckUpdates: true, autoUpdate: true},
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
    {root: 'scmToolkit', key: 'automaticWorkspaceCleanup', value: false, target: 1},
    {root: 'scmToolkit', key: 'messagePlaceholder', value: 'Type a commit message', target: 1},
    {root: 'scmToolkit', key: 'commitButtonLabel', value: 'Save', target: 1},
    {root: 'scmToolkit', key: 'commitAndSendButtonLabel', value: 'Save + Push', target: 1},
    {root: 'scmToolkit', key: 'hideIncomingSyncArrow', value: false, target: 1},
    {root: 'scmToolkit', key: 'hideOutgoingSyncArrow', value: true, target: 1},
    {root: 'scmToolkit', key: 'incomingSyncLabel', value: 'Pulled', target: 1},
    {root: 'scmToolkit', key: 'outgoingSyncLabel', value: 'Pushed', target: 1},
    {root: 'update', key: 'mode', value: 'manual', target: 1},
    {root: 'extensions', key: 'autoCheckUpdates', value: true, target: 1},
    {root: 'extensions', key: 'autoUpdate', value: 'on', target: 1},
    {root: 'editor', key: 'inlineSuggest.enabled', value: false, target: 1},
    {root: 'git', key: 'postCommitCommand', value: 'push', target: 1}
  ]);
  assert.equal(calls.length, 2, 'Saving settings must apply them without reopening the browser');
  updates.length = 0;
  extensionAutoUpdate = false;
  children[0].stdout.emit('data', JSON.stringify({extensionUpdateSettings: {autoUpdate: true}}) + '\n');
  await tick();
  assert.deepEqual(updates, [{root: 'extensions', key: 'autoUpdate', value: true, target: 1}],
    'older VS Code versions keep their boolean representation');
  updates.length = 0;
  extensionAutoUpdate = 'onlyEnabledExtensions';
  children[0].stdout.emit('data', JSON.stringify({extensionUpdateSettings: {autoUpdate: true}}) + '\n');
  await tick();
  assert.deepEqual(updates, [{root: 'extensions', key: 'autoUpdate', value: 'onlyEnabledExtensions', target: 1}],
    'saving another setting preserves a legacy enabled-extensions-only choice');

  children[0].exitCode = 0;
  children[0].emit('exit', 0);
  await open();
  assert.equal(children.length, 2, 'A finished settings session must be restartable');
  assert.deepEqual(Array.from(children[1].spawnArgs).slice(-6), ['--parent-pid', String(process.pid), '--keybindings-file=/stable-home/Code/User/keybindings.json', '--port', '49152', '--token=test']);
  failOpen = true;
  children[1].stdout.emit('data', line + '\n');
  await tick();
  assert.equal(children[1].killed, true);
  assert.match(errors.pop(), /Integrated Browser/);
  failOpen = false;
  children[1].exitCode = 0;
  children[1].emit('exit', 0);
  workspaceState.set('scmToolkit.settingsSessionUrl', 'http://127.0.0.1:49152/?token=-synthetic-test-token');
  await open();
  assert.equal(children[2].spawnArgs.at(-1), '--token=-synthetic-test-token',
    'Tokens beginning with a dash must remain an option value');
  children[2].stdout.emit('data', '{"rebuildComplete":false}\n');
  await tick();
  assert(!calls.some(call => call.id === 'workbench.action.reloadWindow'));
  children[2].stdout.emit('data', '{"rebuildComplete":true}\n{"rebuildComplete":true}\n');
  await tick();
  assert.equal(children[2].killed, true, 'Stop the owning settings server before reloading');
  assert(!calls.some(call => call.id === 'workbench.action.reloadWindow'), 'Wait until its port is released');
  children[2].exitCode = 0;
  children[2].emit('exit', 0);
  await tick();
  assert.equal(calls.filter(call => call.id === 'workbench.action.reloadWindow').length, 1,
    'A successful rebuild reloads its window exactly once');
  await open();
  const shutdown = sandbox.module.exports.deactivate();
  await tick(); // Managed workspace cleanup runs before the settings-server shutdown.
  assert.equal(children[3].killed, true, 'Closing the extension must stop its server');
  children[3].emit('exit', 0);
  await shutdown;
  assert.equal(managedActivityStops, 1, 'Closing the extension must stop managed workspace activity');
  assert.equal(errors.length, 0);
  console.log('Settings native browser checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
