'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  const src = fs.readFileSync(require.resolve('../assets/workbench/picker.js'), 'utf8');
  const first = src.indexOf('function scmToolkitWatchDraftSpellcheck(');
  const last = src.indexOf('\nfunction scmToolkitCreateControls(', first);
  assert(first >= 0 && last > first);
  let id = 0;
  const timers = new Map();
  const listeners = new Set();
  const sandbox = vm.createContext({
    console,
    setTimeout(fn, delay) {
      const token = ++id;
      timers.set(token, {fn, delay});
      return token;
    },
    clearTimeout(token) { timers.delete(token); }
  });
  vm.runInContext(src.slice(first, last), sandbox);
  const watch = sandbox.scmToolkitWatchDraftSpellcheck;
  const input = {
    value: 'Fix a typo',
    onDidChange(fn) {
      listeners.add(fn);
      return {dispose() { listeners.delete(fn); }};
    },
    setValue(value, _announce) {
      this.value = value;
      for (const listener of listeners) listener();
    }
  };
  const runTimers = async () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const entry of pending) await entry.fn();
  };
  const calls = [];
  const command = {
    async executeCommand(name, uri, message, options) {
      calls.push({name, uri, message, options});
      return '🐛 ' + message;
    }
  };
  const subscription = watch(
    input, {scheme: 'file', fsPath: '/repo'}, command, () => false,
    {spellcheck: false, professionalEmoji: true, review: false, delaySeconds: 2.4}
  );
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 2400, 'Custom idle interval is honored');
  await runTimers();
  assert.equal(input.value, '🐛 Fix a typo', 'Emoji-only mode uses the existing draft path');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.spellcheck, false);
  assert.equal(calls[0].options.professionalEmoji, true);
  assert.equal(calls[0].options.review, false);
  assert.equal(timers.size, 0, 'Applying the correction does not spin another check');
  const previous = calls.length;
  input.setValue('🐛 Fix a typo', false);
  assert.equal(timers.size, 0, 'Identical titles are not checked repeatedly');

  let resolvePending;
  command.executeCommand = (...args) => {
    calls.push(args);
    return new Promise(resolve => { resolvePending = resolve; });
  };
  input.setValue('Repair the button');
  assert.equal(timers.size, 1);
  const running = runTimers();
  await Promise.resolve();
  input.setValue('Newer user-written title');
  resolvePending('🖌️ Repair the button');
  await running;
  for (let index = 0; index < 5; index++) await Promise.resolve();
  assert.equal(input.value, 'Newer user-written title', 'A stale model result never overwrites typing');
  assert.equal(timers.size, 1, 'The newest title is queued for checking');
  subscription.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(calls.length, previous + 1);
  console.log('Draft spellchecking: adjustable delay, independent emoji, staleness and cleanup passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
