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
const generating = service.notify({ message: 'Generating commit message' });
assert.equal(timers.length, 5, 'Active commit generation must not expire after 20 seconds');
generating.close();

// A GitHub PR merge notification originates in the extension host. Its
// showInformationMessage call may bypass the service methods wrapped above.
const modelTimers = [];
const modelCtx = vm.createContext({
  WeakSet,
  WeakMap,
  setTimeout(callback, delay) {
    const timer = { callback, delay, cancelled: false };
    modelTimers.push(timer);
    return timer;
  },
  clearTimeout(timer) { timer.cancelled = true; }
});
vm.runInContext(source.slice(start, end), modelCtx);
const modelListeners = [];
const makeItem = raw => {
  const onClose = [];
  return {
    message: { raw },
    closed: 0,
    close() {
      this.closed++;
      model.notifications.splice(model.notifications.indexOf(this), 1);
      onClose.forEach(fn => fn());
    },
    onDidClose(fn) { onClose.push(fn); }
  };
};
const oldMerged = makeItem('PR #17 merged into main.');
const updatePrompt = makeItem('Sweetiebot update ready');
const model = {
  notifications: [oldMerged, updatePrompt],
  onDidChangeNotification(fn) { modelListeners.push(fn); }
};
const nativeService = {
  model,
  info() { throw new Error('Model-backed notifications must not require wrapping info'); }
};
modelCtx.scmToolkitExpireNotifications(nativeService);
modelCtx.scmToolkitExpireNotifications(nativeService);
assert.equal(modelListeners.length, 1, 'Only one model listener per service');
assert.equal(modelTimers.length, 1, 'Already-open merged PR expires, update remains actionable');
assert.equal(modelTimers[0].delay, 20_000);
assert.equal(nativeService.info.toString().includes('throw new Error'), true, 'No service monkeypatch');
const merged = makeItem('PR #18 merged into main.');
model.notifications.unshift(merged);
modelListeners[0]({ kind: 0, item: merged }); // An extension-host showInformationMessage.
assert.equal(modelTimers.length, 2, 'New merged PR notification should be tracked');
modelListeners[0]({ kind: 1, item: merged });
assert.equal(modelTimers.length, 2, 'Content changes must not restart expiry');
modelTimers[1].callback();
assert.equal(merged.closed, 1);
assert.equal(modelTimers[1].cancelled, false, 'Expired timer was not manually cancelled');
modelTimers[0].callback();
assert.equal(oldMerged.closed, 1);
assert.equal(updatePrompt.closed, 0);
const manuallyDismissed = makeItem('PR #19 merged into main.');
model.notifications.unshift(manuallyDismissed);
modelListeners[0]({ kind: 0, item: manuallyDismissed });
manuallyDismissed.close();
assert(modelTimers[2].cancelled, 'Manual dismissal cancels the model timer');
const changedToUpdate = makeItem('Other notice');
model.notifications.unshift(changedToUpdate);
modelListeners[0]({ kind: 0, item: changedToUpdate });
changedToUpdate.message.raw = 'Sweetiebot update ready';
modelListeners[0]({ kind: 1, item: changedToUpdate });
assert(modelTimers[3].cancelled, 'Message changed into an actionable update must stay open');
const changedFromUpdate = makeItem('Sweetiebot update ready');
model.notifications.unshift(changedFromUpdate);
modelListeners[0]({ kind: 0, item: changedFromUpdate });
assert.equal(modelTimers.length, 4, 'Actionable updates must not receive timers');
changedFromUpdate.message.raw = 'PR #20 merged into main.';
modelListeners[0]({ kind: 1, item: changedFromUpdate });
assert.equal(modelTimers.length, 5, 'Notice losing its exemption should expire');
modelTimers[4].callback();
assert.equal(changedFromUpdate.closed, 1);
const activeCommit = makeItem('Generating commit message');
model.notifications.unshift(activeCommit);
modelListeners[0]({ kind: 0, item: activeCommit });
assert.equal(modelTimers.length, 5, 'Model-backed commit progress must stay open');
activeCommit.close();

console.log('Sweetiebot notification timeout tests passed.');
