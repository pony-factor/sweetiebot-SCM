'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/browser/pull_request_submit.js'), 'utf8');
function fixture({ url = 'https://chatgpt.com/?q=Draft%20PR&sweetiebot_pr=1', text = 'Draft PR', disabled = false, label = 'Send prompt', sidebar = false } = {}) {
  let clicks = 0, sidebarClicks = 0, now = 0, timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const composer = { innerText: text };
  const sidebarButton = { disabled: false, getAttribute: key => key === 'aria-label' ? 'Hide sidebar' : null,
    getClientRects: () => [1], click: () => { sidebarClicks++; sidebar = false; } };
  const button = { disabled, getAttribute: key => key === 'aria-label' ? label : null,
    getClientRects: () => [1], click: () => { clicks++; } };
  const window = { location: new URL(url) }; window.top = window;
  const history = { state: {}, replaceState(state, title, url) { window.location = new URL(url); } };
  vm.runInNewContext(source, { window, history, URL, Date: { now: () => now },
    clearTimeout: id => timers.delete(id), setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    document: { querySelector: selector => selector === '#prompt-textarea' ? composer :
      selector.includes('Hide sidebar') ? (sidebar ? sidebarButton : null) : button,
      addEventListener: (name, callback) => {
        const callbacks = listeners.get(name) || new Set(); callbacks.add(callback); listeners.set(name, callbacks);
      },
      removeEventListener: (name, callback) => listeners.get(name)?.delete(callback) } });
  return { composer, button, window, listeners, clicks: () => clicks,
    sidebarClicks: () => sidebarClicks, revealSidebar: () => { sidebar = true; },
    tick(ms = 250) { now += ms; const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
}
let f = fixture({ disabled: true });
assert.equal(f.clicks(), 0);
f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 1);
assert.equal(f.window.location.search, ''); f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ text: '' }); f.tick(); assert.equal(f.clicks(), 0);
f.composer.innerText = 'Draft\nPR'; f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ text: 'Different draft' }); f.tick(); assert.equal(f.clicks(), 0);
f = fixture({ disabled: true }); f.listeners.get('input').forEach(callback => callback({ isTrusted: true }));
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
f = fixture({ sidebar: true });
assert.equal(f.sidebarClicks(), 1);
assert.equal(f.clicks(), 1);
f.revealSidebar(); f.tick(); assert.equal(f.sidebarClicks(), 1); // User can reopen it.
f = fixture(); // Sidebar can hydrate after sending and SPA navigation.
f.window.location.pathname = '/c/new'; f.revealSidebar(); f.tick();
assert.equal(f.sidebarClicks(), 1); assert.equal(f.clicks(), 1);
f = fixture({ url: 'https://chatgpt.com/?q=Draft%20PR', sidebar: true });
assert.equal(f.sidebarClicks(), 0);
f = fixture(); f.tick(60000); f.revealSidebar(); f.tick(); assert.equal(f.sidebarClicks(), 0);
f = fixture();
f.listeners.get('click').forEach(callback => callback({ isTrusted: true,
  target: { closest: () => ({ getAttribute: () => 'Show sidebar' }) } }));
f.revealSidebar(); f.tick(); assert.equal(f.sidebarClicks(), 0);
console.log('Browser PR Send-button and sidebar checks passed.');
