'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/browser/pull_request_submit.js'), 'utf8');
function fixture({ url = 'https://chatgpt.com/?q=Draft%20PR&sweetiebot_pr=1', text = 'Draft PR', disabled = false, label = 'Send prompt', sidebar = false, projectComposer = false, resultLinks = [], streaming = false, formatInserted = text => text } = {}) {
  let clicks = 0, sidebarClicks = 0, now = 0, timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const composer = { innerText: text, getClientRects: () => [1], focus() {} };
  const sidebarButton = { disabled: false, getAttribute: key => key === 'aria-label' ? 'Hide sidebar' : null,
    getClientRects: () => [1], click: () => { sidebarClicks++; sidebar = false; } };
  const button = { disabled, getAttribute: key => key === 'aria-label' ? label : null,
    getClientRects: () => [1], click: () => { clicks++; } };
  const navigations = [];
  const location = value => Object.assign(new URL(value), {assign(value){navigations.push(value);}});
  const persisted = new Map([['oai/apps/lightweight-web/composerDraft/v1', 'Keep the unrelated user draft']]);
  class Storage {
    getItem(key) { return persisted.get(key) ?? null; }
    setItem(key,value) { persisted.set(key,String(value)); }
    removeItem(key) { persisted.delete(key); }
  }
  const window = { location: location(url), Storage, localStorage:new Storage() }; window.top = window;
  const history = { state: {}, replaceState(state, title, url) { window.location = location(url); } };
  vm.runInNewContext(source, { window, history, URL, URLSearchParams, Date: { now: () => now },
    require(name) { assert.equal(name,'electron');return {contextBridge:{executeInMainWorld({func}){vm.runInNewContext('('+func.toString()+')()', {window});}}}; },
    clearTimeout: id => timers.delete(id), setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    document: { execCommand(command, ui, value) { assert.equal(command, 'insertText'); composer.innerText = formatInserted(value); listeners.get('input')?.forEach(callback => callback({ isTrusted: true })); return true; }, querySelector: selector => selector === '#prompt-textarea' ? (projectComposer ? null : composer) :
      selector === '[contenteditable="true"][role="textbox"].ProseMirror' ? composer :
      selector.includes('Hide sidebar') ? (sidebar ? sidebarButton : null) :
      selector.includes('Stop streaming') ? (streaming ? button : null) : button,
      querySelectorAll: selector => {
        assert.equal(selector, 'a[href]', 'Collect exact nonce callbacks across ChatGPT message layouts');
        return resultLinks.map(href=>({href}));
      },
      addEventListener: (name, callback) => {
        const callbacks = listeners.get(name) || new Set(); callbacks.add(callback); listeners.set(name, callbacks);
      },
      removeEventListener: (name, callback) => listeners.get(name)?.delete(callback) } });
  return { composer, button, window, listeners, navigations, persisted, setStreaming(value){streaming=value;}, clicks: () => clicks,
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
f = fixture({ disabled: true }); f.tick(180000); f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 0);
for (const label of ['Stop', 'Start Voice']) { f = fixture({ label }); f.tick(); assert.equal(f.clicks(), 0); }
f = fixture({ url: 'https://chatgpt.com/g/g-p-test123/project?q=Draft%20PR&sweetiebot_pr=1' });
assert.equal(f.clicks(), 1);
f = fixture({ url: 'https://chatgpt.com/g/g-p-test123/project?q=Draft%20PR&sweetiebot_pr=1', projectComposer: true, label: 'Send' });
assert.equal(f.clicks(), 1);
f = fixture({ projectComposer: true, text: 'Edited project draft', label: 'Send' });
f.tick(); assert.equal(f.clicks(), 0);
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

const fragmentUrl = 'https://chatgpt.com/g/g-p-test123/project#sweetiebot_pr=1&q=' + encodeURIComponent('Draft PR');
f = fixture({ url: fragmentUrl, text: '', disabled: true });
assert.equal(f.composer.innerText, 'Draft PR');
assert.equal(f.window.location.hash, '', 'Clear the payload before ChatGPT hydrates');
assert.equal(f.clicks(), 0);
f.button.disabled = false; f.tick();
assert.equal(f.clicks(), 1);
assert.equal(f.window.location.hash, '');
f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ url: fragmentUrl, text: '', formatInserted: text => text.replace('Draft PR', 'DraftPR') });
f.tick();assert.equal(f.clicks(),1,'Own inserted text tolerates composer whitespace formatting');
f = fixture({ url: fragmentUrl, text: 'Keep my draft' });
f.tick(); assert.equal(f.composer.innerText, 'Keep my draft'); assert.equal(f.clicks(), 0);
f = fixture({ url: fragmentUrl, text: '', disabled: true });
f.listeners.get('input').forEach(callback => callback({ isTrusted: true }));
f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 0);
const largePrompt = 'Evidence 🫧 & backrefs\n'.repeat(6000);
f = fixture({ url: 'https://chatgpt.com/#sweetiebot_pr=1&q=' + encodeURIComponent(largePrompt), text: '' });
assert.equal(f.composer.innerText, '');
f.tick(); assert.equal(f.clicks(), 0, 'Reject an oversized encoded launch');
console.log('Fragment handoff checks passed.');

const callback = 'http://127.0.0.1:1234/kefania-draft/11111111-2222-4333-8444-555555555555/pony';
const returnUrl = callback+'#profile=Verified%20Bushel%20profile';
const collectLaunch = fragmentUrl+'&return_to='+encodeURIComponent(callback);
f = fixture({url:collectLaunch,text:'Draft PR',resultLinks:[returnUrl],streaming:true});
const storageKey='oai/apps/lightweight-web/composerDraft/v1';
assert.equal(f.window.localStorage.getItem(storageKey),null,'Workflow tab starts with an isolated blank draft');
f.window.localStorage.setItem(storageKey,'Workflow text');
assert.equal(f.window.localStorage.getItem(storageKey),'Workflow text');
assert.equal(f.persisted.get(storageKey),'Keep the unrelated user draft','Original shared draft is never overwritten');
f.window.localStorage.removeItem(storageKey);
assert.equal(f.persisted.get(storageKey),'Keep the unrelated user draft');
assert.equal(f.clicks(),1);
f.tick(2500); assert.equal(f.navigations.length,0,'Never collect a streaming partial result');
f.setStreaming(false);f.tick(2500);assert.deepEqual(f.navigations,[returnUrl]);
const revisedUrl = callback+'#profile=Revised%20verified%20profile';
f = fixture({url:collectLaunch,text:'',resultLinks:[returnUrl,revisedUrl]});
f.tick(2500);
assert.deepEqual(f.navigations,[revisedUrl], 'Repeated return links stabilize on the final result');
for(const bad of [returnUrl.replace(':1234',':4567'),returnUrl.replace('/pony','/draft'),returnUrl+'&publish=true']){
  f=fixture({url:collectLaunch,text:'',resultLinks:[bad]});f.tick(3000);
  assert.equal(f.navigations.length,0,'Collect only this workflow’s exact local callback');
}
console.log('Independent result collection checks passed.');
