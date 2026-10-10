'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/workbench/picker.js'), 'utf8');
const start = source.indexOf('const scmToolkitTimedNotificationServices = new WeakSet();');
const end = source.indexOf('function scmToolkitCreateControls(', start);
assert(start >= 0 && end > start, 'notification helper must exist');
assert(source.includes('scmToolkitExpireNotifications(notifications);'));
const timers = [];
const ctx = vm.createContext({
  WeakSet,
  setTimeout(callback, delay) {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return timer;
  },
  clearTimeout(timer) { timer.cancelled = true; }
});
vm.runInContext(source.slice(start, end), ctx);
const install = ctx.scmToolkitExpireNotifications;
const makeHandle = () => {
  const callbacks = [];
  return {
    closed: 0,
    close() { this.closed++; callbacks.forEach(fn => fn()); },
    onDidClose(fn) { callbacks.push(fn); }
  };
};
const service = {
  notify() { return makeHandle(); },
  prompt(_severity, message) { return this.notify({ message }); },
  info(message) { return this.notify({ message }); },
  warn(message) { return this.notify({ message }); },
  error(message) { return this.notify({ message }); }
};
install(service);
install(service); // Duplicate SCM widgets must not add wrappers.
const info = service.info('Workspace Search index cleared.');
assert.equal(timers.length, 1);
assert.equal(timers[0].delay, 20_000);
const update = service.prompt(1, 'Sweetiebot update ready', ['Reload Window']);
assert.equal(timers.length, 1, 'Update prompt cannot time out');
const warning = service.warn('Unexpected state');
const error = service.error('Unable to merge PR');
assert.equal(timers.length, 3, 'Warnings and errors receive one timer each');
timers[0].callback();
assert.equal(info.closed, 1);
assert(timers[0].cancelled);
timers[1].callback();
assert.equal(warning.closed, 1);
timers[2].callback();
assert.equal(error.closed, 1);
const dismissed = service.notify({ message: 'Another notice' });
dismissed.close();
assert(timers[3].cancelled, 'Manual dismissal cancels the timer');
const markdown = service.notify({ message: { value: 'Markdown notice' } });
assert.equal(timers.length, 5);
timers[4].callback();
assert.equal(markdown.closed, 1);
assert.equal(update.closed, 0);
console.log('Sweetiebot notification timeout tests passed.');
