'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture(platform = 'darwin', defaultEnabled = true) {
  let notify, fatal, changed, override;
  const children = [], disposals = [], timers = new Set();
  const disposable = name => ({ dispose() { disposals.push(name); } });
  const sandbox = vm.createContext({
    process: { platform, pid: 123 },
    setTimeout(callback, delay) {
      assert.equal(delay, 20000);
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
    require(name) {
      assert.equal(name, 'child_process');
      return { spawn(executable, args, options) {
        assert.equal(executable, '/usr/bin/caffeinate');
        assert.deepEqual(Array.from(args), ['-d', '-i', '-u', '-t', '30', '-w', '123']);
        assert.equal(options.stdio, 'ignore');
        const child = new EventEmitter();
        child.kill = () => { child.killed = true; };
        children.push(child);
        return child;
      } };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../assets/codex/keep-awake.js'), 'utf8'), sandbox);
  sandbox.connection = {
    registerInternalNotificationHandler(callback) { notify = callback; return disposable('notifications'); },
    registerProvider(name, callbacks) { fatal = callbacks.onFatalError; return disposable('provider'); }
  };
  sandbox.vscode = {
    workspace: {
      getConfiguration() { return { inspect: () => ({ globalValue: override }) }; },
      onDidChangeConfiguration(callback) { changed = callback; return disposable('configuration'); }
    },
    window: { showWarningMessage() {} }
  };
  const controller = vm.runInContext(`scmToolkitRegisterCodexKeepAwake(connection, vscode, ${defaultEnabled})`, sandbox);
  const event = (method, threadId, turnId, status) => notify({ method, params: { threadId, turn: { id: turnId }, status } });
  return { children, controller, disposals, timers, event, tick() {
    const pending = Array.from(timers);
    timers.clear();
    for (const timer of pending) timer.callback();
  }, fatal: () => fatal(), override(value) {
    override = value;
    changed({ affectsConfiguration: key => key === 'scmToolkit.codexKeepAwake' });
  } };
}

{
  const f = fixture();
  assert.equal(f.children.length, 0, 'Idle Codex does not prevent sleep');
  f.event('turn/started', 'a', '1');
  f.event('turn/started', 'b', '2');
  assert.equal(f.children.length, 1, 'Concurrent threads share an assertion');
  f.event('turn/completed', 'a', '1');
  assert(!f.children[0].killed);
  f.event('turn/started', 'b', '3');
  f.event('turn/completed', 'b', '2');
  assert(!f.children[0].killed, 'Old completion does not release a newer turn');
  f.event('turn/completed', 'b', '3');
  assert(f.children[0].killed);
  f.event('thread/status/changed', 'c', undefined, { type: 'active' });
  assert.equal(f.children.length, 2);
  f.override(false);
  assert(f.children[1].killed, 'Disabling takes effect during work');
  f.override(true);
  assert.equal(f.children.length, 3);
  f.children[1].emit('exit');
  f.event('turn/started', 'd', '4');
  assert.equal(f.children.length, 3, 'An old exit cannot clear the current assertion');
  f.fatal();
  assert(f.children[2].killed, 'Server failure releases sleep prevention');
  f.event('turn/started', 'e', '5');
  f.controller.dispose();
  assert(f.children[3].killed);
  assert.deepEqual(f.disposals, ['notifications', 'provider', 'configuration']);
}
{
  const f = fixture();
  f.event('turn/started', 'a', '1');
  f.tick();
  assert(f.children[0].killed, 'Renewal releases the previous assertion');
  assert.equal(f.children.length, 2, 'Long tasks renew user activity before expiry');
  f.children[0].emit('exit');
  f.event('turn/started', 'b', '2');
  assert.equal(f.children.length, 2, 'A retired child cannot clear renewed protection');
  f.event('turn/completed', 'a', '1');
  assert(!f.children[1].killed, 'Other active work retains protection');
  f.event('turn/completed', 'b', '2');
  assert(f.children[1].killed);
  assert.equal(f.timers.size, 0, 'Idle state cancels renewal');
  f.tick();
  assert.equal(f.children.length, 2, 'Finished work cannot restart protection');
  f.controller.dispose();
}
for (const terminal of ['idle', 'notLoaded', 'systemError']) {
  const f = fixture();
  f.event('thread/status/changed', 'a', undefined, { type: 'active' });
  f.event('thread/status/changed', 'a', undefined, { type: terminal });
  assert(f.children[0].killed);
}
for (const waiting of ['waitingOnApproval', 'waitingOnUserInput']) {
  const f = fixture();
  f.event('turn/started', 'a', '1');
  f.event('thread/status/changed', 'a', undefined, {type:'active',activeFlags:[waiting]});
  assert(f.children[0].killed, 'Waiting for the user permits idle sleep');
  assert.equal(f.timers.size,0);
  f.event('thread/status/changed', 'a', undefined, {type:'active',activeFlags:[]});
  assert.equal(f.children.length,2,'Resumed work restores protection');
  f.event('turn/completed', 'a', '1');
  assert(f.children[1].killed);
  f.controller.dispose();
}
{
  const f = fixture('darwin', false);
  f.event('turn/started', 'a', '1');
  assert.equal(f.children.length, 0);
  f.override(true);
  assert.equal(f.children.length, 1);
  f.controller.dispose();
}
{
  const f = fixture('linux');
  f.controller.dispose();
  assert.equal(f.children.length, 0);
}
assert.equal(require('../extension/package.json').contributes.configuration.properties['scmToolkit.codexKeepAwake'].default, true);
console.log('Codex keep-awake lifecycle checks passed.');
