'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/browser/pull_request_submit.js'), 'utf8');
function fixture({ url = 'https://chatgpt.com/?q=Draft%20PR&sweetiebot_pr=1', text = 'Draft PR', disabled = false, label = 'Send prompt' } = {}) {
  let next, clicks = 0, now = 0;
  const listeners = new Map();
  const composer = { innerText: text };
  const button = { disabled, getAttribute: key => key === 'aria-label' ? label : null,
    getClientRects: () => [1], click: () => { clicks++; } };
  const window = { location: new URL(url) }; window.top = window;
  const history = { state: {}, replaceState(state, title, url) { window.location = new URL(url); } };
  vm.runInNewContext(source, { window, history, URL, Date: { now: () => now },
    clearTimeout: () => { next = undefined; }, setTimeout: callback => { next = callback; },
    document: { querySelector: selector => selector === '#prompt-textarea' ? composer : button,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name) } });
  return { composer, button, window, listeners, clicks: () => clicks,
    tick(ms = 250) { now += ms; const callback = next; next = undefined; callback?.(); } };
}
let f = fixture({ disabled: true });
assert.equal(f.clicks(), 0);
f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 1);
assert.equal(f.window.location.search, ''); f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ text: '' }); f.tick(); assert.equal(f.clicks(), 0);
f.composer.innerText = 'Draft\nPR'; f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ text: 'Different draft' }); f.tick(); assert.equal(f.clicks(), 0);
f = fixture({ disabled: true }); f.listeners.get('input')({ isTrusted: true });
f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 0);
f = fixture({ disabled: true }); f.tick(60000); f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 0);
for (const label of ['Stop', 'Start Voice']) { f = fixture({ label }); f.tick(); assert.equal(f.clicks(), 0); }
f = fixture({ url: 'https://chatgpt.com/g/g-p-test123/project?q=Draft%20PR&sweetiebot_pr=1' });
assert.equal(f.clicks(), 1);
f = fixture({ disabled: true }); f.window.location.pathname = '/c/new';
f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 0);
for (const url of ['https://chatgpt.com/?q=Draft%20PR', 'https://example.com/?q=Draft%20PR&sweetiebot_pr=1', 'https://chatgpt.com/c/123?q=Draft%20PR&sweetiebot_pr=1']) {
  f = fixture({ url }); f.tick(); assert.equal(f.clicks(), 0);
}
console.log('Browser PR Send-button checks passed.');
