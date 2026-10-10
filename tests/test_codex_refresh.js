'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
const timers = new Map();
const intervals = new Map();
let enabled = true, installed = true;
let revision = 'initial';
let choice, releaseServer, stopping = false, reloads = 0;
const notices = [];
let invalidations = 0;
let timerId = 0, changed, focusChanged, extensionPath = '/extensions/codex-old', launches = 0;
const children = [];
const sandbox = vm.createContext({
  module: { exports: {} }, process: { platform: 'darwin', env: {} },
  setInterval(fn) { intervals.set(++timerId, fn); return timerId; },
  clearInterval(id) { intervals.delete(id); },
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  require(name) {
    if (name === 'path') return path;
    if (name === './runtime_revision') return { runtimeRevision() { return revision; } };
    if (name === './extension_cache') return { invalidateUserExtensionCache() { invalidations++; return true; } };
    assert.equal(name, 'child_process');
    return { spawn(executable, args) {
      launches++;
      assert.equal(executable, 'python3');
      assert.deepEqual(Array.from(args), ['/toolkit/codex-customizations/scripts/repair.py',
        '--app', '/Custom/Code.app', ...(installed ? ['--codex-extension', extensionPath] : [])]);
      const callbacks = new Map();
      const child = { stdout: { on(event, fn) { callbacks.set('stdout', fn); } }, stderr: { on() {} },
        on(event, fn) { callbacks.set(event, fn); },
        kill() { this.killed = true; }, callbacks };
      children.push(child);
      return child;
    } };
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../efs/codex_refresh.js'), 'utf8'), sandbox);
const context = { subscriptions: [], extensionUri: { fsPath: '/toolkit' } };
const vscode = {
  env: { appRoot: '/Custom/Code.app/Contents/Resources/app' },
  workspace: { getConfiguration() { return { get() { return enabled; } }; },
    onDidChangeConfiguration() { return { dispose() {} }; } },
  commands: { executeCommand(command) { assert.equal(command, 'workbench.action.reloadWindow'); reloads++; } },
  Uri: { joinPath(uri, ...parts) { return { fsPath: [uri.fsPath, ...parts].join('/') }; } },
  window: { onDidChangeWindowState(fn) { focusChanged = fn; return { dispose() {} }; }, showInformationMessage(message) { notices.push(message); return Promise.resolve(choice); }, createOutputChannel() { return { append() {}, appendLine() {}, dispose() {} }; } },
  extensions: {
    getExtension() { return installed ? { extensionPath } : undefined; },
    onDidChange(fn) { changed = fn; return { dispose() {} }; }
  }
};
function tick() {
  const [id, fn] = timers.entries().next().value;
  timers.delete(id); fn();
}
sandbox.module.exports.registerCodexRefresh(vscode, context, () => {
  stopping = true;
  return new Promise(resolve => { releaseServer = resolve; });
});
tick();
assert.equal(launches, 1, 'startup repairs the selected Codex installation');
changed();
// Run the debounce timer, leaving the subprocess timeout alone.
const [id, fn] = [...timers.entries()].at(-1); timers.delete(id); fn();
assert.equal(launches, 1, 'update events cannot launch concurrent installers');
extensionPath = '/extensions/codex-new';
children[0].callbacks.get('close')(0);
tick();
assert.equal(launches, 2, 'queued repair resolves the new selected extension path');
children[1].callbacks.get('stdout')('Installed SCM toolkit for VS Code 1.0. Reload VS Code.');
revision = 'updated';
choice = 'Reload Window';
children[1].callbacks.get('close')(0);
assert.equal(notices.length, 0, 'reload is withheld until the quiet period elapses');
tick();
assert.equal(notices.length, 1, 'successful settled repair offers one reload');
assert.equal(invalidations, 1, 'VS Code extension cache is cleared before the offered reload');
await Promise.resolve();
assert.equal(stopping, true);
assert.equal(reloads, 0, 'reload waits for the old settings server to exit');
releaseServer();
await new Promise(resolve => setImmediate(resolve));
assert.equal(reloads, 1);
focusChanged({ focused: false });
assert.equal(timers.size, 0, 'unfocused windows do not repair');
choice = undefined;
revision = 'changed-by-another-window';
focusChanged({ focused: true });
tick();
assert.equal(launches, 3, 'returning to a stale window checks installed updates immediately');
children.at(-1).callbacks.get('close')(0);
tick();
assert.equal(notices.length, 2);
// A newly loaded window already has those bytes, even if the installer reports work again.
const reloaded = { ...context, subscriptions: [] };
const originalChanged = changed;
sandbox.module.exports.registerCodexRefresh(vscode, reloaded);
tick();
children.at(-1).callbacks.get('stdout')('Installed SCM toolkit for VS Code 1.0. Reload VS Code.');
children.at(-1).callbacks.get('close')(0);
tick();
assert.equal(notices.length, 2, 'reloading does not offer the same update again');
assert.equal(invalidations, 2, 'an unchanged reloaded window does not touch the extension cache');
focusChanged({ focused: true });
assert.equal(timers.size, 0, 'an unchanged focused window does not repair');
reloaded.subscriptions.at(-1).dispose();
changed = originalChanged;
enabled = false; changed();
assert.equal(timers.size, 0, 'disabled repair does not queue a run');
assert.equal(launches, 4, 'disabled repair cannot launch');
enabled = true; installed = false;
[...intervals.values()][0](); tick();
assert.equal(launches, 5, 'workbench repair works without Codex installed');
context.subscriptions.at(-1).dispose();
assert.equal(children.at(-1).killed, true);
children.at(-1).callbacks.get('close')(0);
assert.equal(intervals.size, 0);
assert.equal(timers.size, 0, 'disposal cancels repair and its timeout');
const retryContext = { ...context, subscriptions: [] };
sandbox.module.exports.registerCodexRefresh(vscode, retryContext);
tick();
const noticesBeforeBusy = notices.length;
children.at(-1).callbacks.get('close')(75);
assert.equal(notices.length, noticesBeforeBusy, 'a busy updater never offers a premature reload');
assert.equal(timers.size, 1, 'a busy updater schedules a retry');
tick();
assert.equal(launches, 7, 'the waiting window retries without a reload');
retryContext.subscriptions.at(-1).dispose();
console.log('Codex update repair lifecycle checks passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
