'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const timers = new Map();
let timerId = 0, changed, extensionPath = '/extensions/codex-old', launches = 0;
const children = [];
const sandbox = vm.createContext({
  module: { exports: {} }, process: { platform: 'darwin' },
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
  clearTimeout(id) { timers.delete(id); },
  require(name) {
    assert.equal(name, 'child_process');
    return { spawn(executable, args) {
      launches++;
      assert.equal(executable, 'python3');
      assert.deepEqual(Array.from(args), ['/toolkit/codex-customizations/scripts/install.py',
        '--codex-only', '--codex-extension', extensionPath]);
      const callbacks = new Map();
      const child = { stdout: { on() {} }, stderr: { on() {} },
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
  Uri: { joinPath(uri, ...parts) { return { fsPath: [uri.fsPath, ...parts].join('/') }; } },
  window: { createOutputChannel() { return { append() {}, appendLine() {}, dispose() {} }; } },
  extensions: {
    getExtension() { return { extensionPath }; },
    onDidChange(fn) { changed = fn; return { dispose() {} }; }
  }
};
function tick() {
  const [id, fn] = timers.entries().next().value;
  timers.delete(id); fn();
}
sandbox.module.exports.registerCodexRefresh(vscode, context);
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
context.subscriptions.at(-1).dispose();
assert.equal(children[1].killed, true);
children[1].callbacks.get('close')(0);
assert.equal(timers.size, 0, 'disposal cancels repair and its timeout');
console.log('Codex update repair lifecycle checks passed.');
