'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/codex/rate-limit-continuation.js'), 'utf8');

function setup(enabled, noticeText = 'Rate limited · resets in 1 second') {
  const messages = [], microtasks = [], timers = [], listeners = {};
  const state = { now: 1000, queued: false, threadId: 'chat-one', composerText: '' };
  const notice = { textContent: noticeText, dataset: {}, closest: () => null };
  let observed = false, elementCreated = false;
  const context = vm.createContext({
    document: {
      documentElement: {},
      querySelectorAll(selector) { return selector.startsWith('p, span,') ? [notice] : []; },
      querySelector(selector) {
        if (selector.startsWith('[data-testid="queued-message"]')) return state.queued ? {} : null;
        if (selector.includes('textarea')) return { get textContent() { return state.composerText; }, value: '' };
        return null;
      },
      createElement() { elementCreated = true; throw Error('Must not add composer control'); },
    },
    window: { addEventListener(name, fn) { listeners[name] = fn; } },
    MutationObserver: class { observe() { observed = true; } },
    queueMicrotask(fn) { microtasks.push(fn); },
    clearTimeout(timer) { if (timer) timer.canceled = true; },
    setTimeout(fn, delay) { const timer = { fn, delay, canceled: false }; timers.push(timer); return timer; },
    Date: class extends Date { static now() { return state.now; } },
  });
  vm.runInContext(source.replace('__SCM_TOOLKIT_CONTINUE_AT_RESET_ENABLED__', String(enabled)), context);
  context.scmToolkitInstallRateLimitContinuation({postMessage(message) { messages.push(message); }}, () => state.threadId);
  return {
    state, messages, listeners,
    flush() { while (microtasks.length) microtasks.shift()(); },
    advance(to) {
      state.now = to;
      for (const timer of timers.filter(t => !t.canceled)) { timer.canceled = true; timer.fn(); }
    },
    get observed() { return observed; },
    get elementCreated() { return elementCreated; },
  };
}
const disabled = setup(false);
assert.equal(disabled.observed, false);
assert.equal(disabled.messages.length, 0);
const enabled = setup(true);
assert.equal(enabled.observed, true);
enabled.flush();
assert.equal(enabled.messages.length, 0);
enabled.advance(3000);
assert.deepEqual(JSON.parse(JSON.stringify(enabled.messages)),
  [{type:'scm-toolkit-continue-at-reset', threadId:'chat-one', resetAt:2000}]);
assert.equal(enabled.elementCreated, false);
enabled.listeners.hashchange();
enabled.flush();
assert.equal(enabled.messages.length, 1, 'Resume at most once per thread/reset');
const draft = setup(true);
draft.state.composerText = 'pending draft';
draft.flush();
draft.advance(3000);
assert.equal(draft.messages.length, 0);
const queued = setup(true);
queued.state.queued = true;
queued.flush();
queued.advance(3000);
assert.equal(queued.messages.length, 0);
const unknown = setup(true, 'Rate limited');
unknown.flush();
assert.equal(unknown.messages[0]?.type, 'scm-toolkit-read-limit-reset');
unknown.advance(30000);
assert.equal(unknown.messages.some(message => message.type === 'scm-toolkit-continue-at-reset'), false);
console.log('Codex settings-controlled continuation safety checks passed.');
