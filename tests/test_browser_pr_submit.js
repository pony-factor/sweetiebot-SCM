'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/browser/pull_request_submit.js'), 'utf8');
function fixture({ url = 'https://chatgpt.com/?q=Draft%20PR&sweetiebot_pr=1', text = 'Draft PR', disabled = false, label = 'Send prompt', sidebar = false, projectComposer = false, resultLinks = [], assistantCodes = [], streaming = false, backgroundStreaming = false, hiddenStop = false, streamError = false, hiddenRetry = false, retryStartsStreaming = true, thinkingReady = true, formatInserted = text => text } = {}) {
  let clicks = 0, sidebarClicks = 0, now = 0, timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const composer = { innerText: text, getClientRects: () => [1], focus() {} };
  const sidebarButton = { disabled: false, getAttribute: key => key === 'aria-label' ? 'Hide sidebar' : null,
    getClientRects: () => [1], click: () => { sidebarClicks++; sidebar = false; } };
  const button = { disabled, getAttribute: key => key === 'aria-label' ? label : null,
    getClientRects: () => [1], click: () => { clicks++; } };
  const navigations = [], retryNotices = [];
  let retries = 0;
  const retryButton = { disabled: false, textContent: 'Retry',
    parentElement: { textContent: 'Error in message stream Retry' },
    getAttribute: () => null, getClientRects: () => hiddenRetry ? [] : [1],
    insertAdjacentElement(position, notice) { assert.equal(position, 'afterend'); retryNotices.push(notice); },
    click() { retries++; if (retryStartsStreaming) { streamError = false; streaming = true; } } };

  const location = value => Object.assign(new URL(value), {assign(value){navigations.push(value);}});
  const persisted = new Map(['oai/apps/lightweight-web/composerDraft/v1', 'oai/apps/conversationDrafts'].map(key => [key, 'Keep the unrelated user draft']));
  class Storage {
    getItem(key) { return persisted.get(key) ?? null; }
    setItem(key,value) { persisted.set(key,String(value)); }
    removeItem(key) { persisted.delete(key); }
  }
  const window = { location: location(url), Storage, localStorage:new Storage() }; window.top = window;
  const history = { state: {}, replaceState(state, title, url) { window.location = location(url); } };
  vm.runInNewContext(source, { window, history, URL, URLSearchParams, Date: { now: () => now },
    sweetiebotEnsureMaximumThinking: () => thinkingReady,
    require(name) { assert.equal(name,'electron');return {contextBridge:{executeInMainWorld({func}){vm.runInNewContext('('+func.toString()+')()', {window});}}}; },
    clearTimeout: id => timers.delete(id), setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    document: { createElement() { return { style: {}, setAttribute() {}, remove() { this.removed = true; } }; }, execCommand(command, ui, value) { if (command === 'selectAll') return true; if (command === 'delete') composer.innerText = ''; else { assert.equal(command, 'insertText'); composer.innerText = formatInserted(value); } listeners.get('input')?.forEach(callback => callback({ type: 'input', isTrusted: true })); return true; }, querySelector: selector => selector === '#prompt-textarea' ? (projectComposer ? null : composer) :
      selector === '[contenteditable="true"][role="textbox"].ProseMirror' ? composer :
      selector.includes('Hide sidebar') ? (sidebar ? sidebarButton : null) :
      selector.includes('Stop streaming') ? (streaming ? button : null) : button,
      querySelectorAll: selector => {
        if (selector.includes('Stop streaming')) return streaming ? [{ ...button, getClientRects: () => backgroundStreaming ? [] : [1] }] : hiddenStop ? [{getClientRects:()=>[]}] : [];
        if (selector === '[data-message-author-role="assistant"] pre code') return assistantCodes.map(textContent => ({ textContent }));
        if (selector === 'button') return streamError ? [retryButton] : [];
        assert.equal(selector, 'a[href]', 'Collect exact nonce callbacks across ChatGPT message layouts');
        return resultLinks.map(href=>({href}));
      },
      addEventListener: (name, callback) => {
        const callbacks = listeners.get(name) || new Set(); callbacks.add(callback); listeners.set(name, callbacks);
      },
      removeEventListener: (name, callback) => listeners.get(name)?.delete(callback) } });
  return { composer, button, window, listeners, navigations, persisted, setStreaming(value){streaming=value;}, setStreamError(value){streamError=value;}, retryButton, retries:()=>retries, retryNotices, setThinkingReady(value){thinkingReady=value;}, clicks: () => clicks,
    sidebarClicks: () => sidebarClicks, revealSidebar: () => { sidebar = true; },
    tick(ms = 250) { now += ms; const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
}
let f = fixture({ disabled: true });
assert.equal(f.clicks(), 0);
f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 1);
assert.equal(f.window.location.search, ''); f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ thinkingReady: false });
f.tick(); assert.equal(f.clicks(), 0, 'Never send before maximum thinking is confirmed');
f.setThinkingReady(true); f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ text: '' }); f.tick(); assert.equal(f.clicks(), 0);
f.composer.innerText = 'Draft\nPR'; f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ text: 'Different draft' }); f.tick(); assert.equal(f.clicks(), 0);
f = fixture({ disabled: true }); f.listeners.get('input').forEach(callback => callback({ type: 'input', isTrusted: true }));
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
f.listeners.get('input').forEach(callback => callback({ type: 'input', isTrusted: true }));
f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 0);
const largePrompt = 'Evidence 🫧 & backrefs\n'.repeat(6000);
f = fixture({ url: 'https://chatgpt.com/#sweetiebot_pr=1&q=' + encodeURIComponent(largePrompt), text: '' });
assert.equal(f.composer.innerText, '');
f.tick(); assert.equal(f.clicks(), 0, 'Reject an oversized encoded launch');
// Batch merge URLs use the same guarded readiness-based send as PR drafting.
const mergeUrl = 'https://chatgpt.com/g/g-p-test123/project#sweetiebot_merge=1&q=' + encodeURIComponent('Merge #41 & #42');
f = fixture({ url: mergeUrl, text: '', disabled: true });
assert.equal(f.composer.innerText, 'Merge #41 & #42');
assert.equal(f.window.location.hash, '', 'Remove the merge payload before hydration');
assert.equal(f.clicks(), 0);
f.button.disabled = false; f.tick();
assert.equal(f.clicks(), 1, 'Send as soon as the button is ready');
f.tick(); assert.equal(f.clicks(), 1, 'Send the merge prompt only once');
f = fixture({ url: mergeUrl, text: 'Keep my draft', disabled: true });
f.tick(); f.tick();
assert.equal(f.composer.innerText, 'Merge #41 & #42', 'Isolate a restored draft in this workflow tab');
assert.equal(f.persisted.get('oai/apps/conversationDrafts'), 'Keep the unrelated user draft');
f.button.disabled = false; f.tick(); assert.equal(f.clicks(), 1);
f = fixture({ url: 'https://chatgpt.com/#sweetiebot_merge=1&q=User%20edited', text: '' });
f.listeners.get('input').forEach(callback => callback({ type: 'input', isTrusted: true }));
f.tick(); assert.equal(f.clicks(), 0, 'Respect user editing');
f = fixture({ url: 'https://chatgpt.com/?sweetiebot_merge=1&q=Not%20fragment', text: 'Not fragment' });
f.tick(); assert.equal(f.clicks(), 0, 'Do not auto-send unmarked query-only merge requests');
f = fixture({ url: 'https://chatgpt.com/#sweetiebot_pr=1&sweetiebot_merge=1&q=Ambiguous', text: 'Ambiguous' });
f.tick(); assert.equal(f.clicks(), 0, 'Reject ambiguous launch markers');
console.log('Fragment and merge handoff checks passed.');

const mergeCallback = 'http://127.0.0.1:1234/lindsey-merge/11111111-2222-4333-8444-555555555555';
const mergeReturn = mergeCallback + '#result=' + encodeURIComponent(JSON.stringify({ version: 1, repository: 'owner/repo', results: [] }));
f = fixture({ url: mergeUrl + '&return_to=' + encodeURIComponent(mergeCallback), text: 'Merge #41 & #42', resultLinks: [mergeReturn], streaming: true });
f.tick(2500); assert.equal(f.navigations.length, 0);
f.setStreaming(false); f.tick(2500);
assert.deepEqual(f.navigations, [mergeReturn], 'Collect a completed local merge result automatically for sequential continuation');
const partialLinks = [mergeCallback + '#result=' + encodeURIComponent('{"version":1,"repository":"owner/repo","results":[{"patch":"unfinished')];
f = fixture({ url: mergeUrl + '&return_to=' + encodeURIComponent(mergeCallback), text: '', resultLinks: partialLinks });
f.tick(2500);
assert.equal(f.navigations.length, 0, 'A streaming or malformed JSON href cannot leave the GPT response');
f.tick(25 * 60 * 1000);
partialLinks.push(mergeReturn); f.tick(); f.tick(2500);
assert.deepEqual(f.navigations, [mergeReturn], 'Merge collection still works after a long conflict review');
f = fixture({ url: mergeUrl + '&return_to=' + encodeURIComponent(mergeCallback), text: '',
  assistantCodes: [JSON.stringify({ version: 1, repository: 'owner/repo', results: [] })] });
f.tick(2500);
assert.deepEqual(f.navigations, [mergeReturn], 'Complete assistant JSON recovers an omitted final apply link');
f = fixture({ url: mergeUrl + '&return_to=' + encodeURIComponent(mergeCallback), text: '',
  resultLinks: [mergeReturn], streaming: true, backgroundStreaming: true });
f.tick(2500);
assert.equal(f.navigations.length, 0, 'A background GPT tab can still be streaming without visible rectangles');
f.setStreaming(false); f.tick(2500);
assert.deepEqual(f.navigations, [mergeReturn]);
for (const invalid of [mergeReturn.replace(':1234', ':4567'),
  mergeReturn + '&command=arbitrary', mergeReturn.replace('11111111', '99999999')]) {
  f = fixture({ url: mergeUrl + '&return_to=' + encodeURIComponent(mergeCallback), text: '', resultLinks: [invalid] });
  f.tick(3000);
  assert.equal(f.navigations.length, 0, 'Reject wrong local callback or unexpected fragment fields');
}
f = fixture({ url: fragmentUrl + '&return_to=' + encodeURIComponent(mergeCallback), text: '', resultLinks: [mergeReturn] });
f.tick(3000);
assert.equal(f.navigations.length, 0, 'A PR drafting launch cannot invoke Lindsey merge callback');

const callback = 'http://127.0.0.1:1234/kefania-draft/11111111-2222-4333-8444-555555555555/pony';
const returnUrl = callback+'#profile=Verified%20Bushel%20profile';
const collectLaunch = fragmentUrl+'&return_to='+encodeURIComponent(callback);
f = fixture({url:collectLaunch,text:'Restored unrelated draft'});
f.tick(); f.tick();
assert.equal(f.clicks(),1,'Fresh isolated workflow replaces a draft restored before isolation');
assert.equal(f.persisted.get('oai/apps/conversationDrafts'),'Keep the unrelated user draft');
f = fixture({url:collectLaunch,text:'Draft PR',resultLinks:[returnUrl],streaming:true});
for (const storageKey of ['oai/apps/lightweight-web/composerDraft/v1', 'oai/apps/conversationDrafts']) {
assert.equal(f.window.localStorage.getItem(storageKey),null,'Workflow tab starts with an isolated blank draft');
f.window.localStorage.setItem(storageKey,'Workflow text');
assert.equal(f.window.localStorage.getItem(storageKey),'Workflow text');
assert.equal(f.persisted.get(storageKey),'Keep the unrelated user draft','Original shared draft is never overwritten');
f.window.localStorage.removeItem(storageKey);
assert.equal(f.persisted.get(storageKey),'Keep the unrelated user draft');
assert.equal(f.window.localStorage[storageKey],undefined,'Named property reads also start blank');
f.window.localStorage[storageKey]='Property workflow text';
assert.equal(f.window.localStorage.getItem(storageKey),'Property workflow text');
assert.equal(f.persisted.get(storageKey),'Keep the unrelated user draft');
delete f.window.localStorage[storageKey];
assert.equal(f.window.localStorage.getItem(storageKey),null);
}
assert.equal(f.clicks(),1);
f.tick(2500); assert.equal(f.navigations.length,0,'Never collect a streaming partial result');
f.setStreaming(false);f.tick(2500);assert.deepEqual(f.navigations,[returnUrl]);
const revisedUrl = callback+'#profile=Revised%20verified%20profile';
f = fixture({url:collectLaunch,text:'',resultLinks:[returnUrl,revisedUrl]});
f.tick(2500);
assert.deepEqual(f.navigations,[revisedUrl], 'Repeated return links stabilize on the final result');
const draftCallback=callback.replace('/pony','/draft');
const draftReturn=draftCallback+'#title=Fix%20italics&body=Verified%20description';
f=fixture({url:fragmentUrl+'&return_to='+encodeURIComponent(draftCallback),resultLinks:[draftReturn],hiddenStop:true});
f.tick(2500);
assert.deepEqual(f.navigations,[draftReturn], 'A hidden Stop button after completion must not block the PR return');
for(const bad of [returnUrl.replace(':1234',':4567'),returnUrl.replace('/pony','/draft'),returnUrl+'&publish=true']){
  f=fixture({url:collectLaunch,text:'',resultLinks:[bad]});f.tick(3000);
  assert.equal(f.navigations.length,0,'Collect only this workflow’s exact local callback');
}
console.log('Independent result collection checks passed.');

// A recognized stream error in this workflow retries the response, never Send.
const retryLaunch = mergeUrl + '&return_to=' + encodeURIComponent(mergeCallback);
f = fixture({ url: retryLaunch, text: '', streamError: true });
f.tick(2500);
assert.equal(f.retries(), 1);
assert.equal(f.clicks(), 1, 'Recovery never resubmits the original prompt');
f.tick(15000);
assert.equal(f.retries(), 1, 'An active recovered response cannot be retried again');
f = fixture({ url: retryLaunch, streamError: true, retryStartsStreaming: false });
f.tick(2500); f.tick(10000); f.tick(10000); f.tick(10000);
assert.equal(f.retries(), 2, 'Automatic response retries are bounded');
assert.match(f.retryNotices.at(-1).textContent, /stopped after two attempts/);
for (const options of [
  { hiddenRetry: true }, { streaming: true }, { resultLinks: [mergeReturn] }
]) {
  f = fixture({ url: retryLaunch, streamError: true, ...options });
  f.tick(2500);
  assert.equal(f.retries(), 0, 'Hidden controls, active generation and a ready handoff cannot trigger recovery');
}
f = fixture({ url: retryLaunch, streamError: true });
f.listeners.get('input').forEach(fn => fn({ type: 'input', isTrusted: true }));
f.tick(2500);
assert.equal(f.retries(), 0, 'A user editing the chat takes control of recovery');
f = fixture({ url: retryLaunch, streamError: true });
f.retryButton.parentElement.textContent = 'An unrelated operation failed Retry';
f.tick(2500);
assert.equal(f.retries(), 0, 'Only recognized response-stream errors are retried');
f = fixture({ url: mergeUrl, streamError: true });
f.tick(2500);
assert.equal(f.retries(), 0, 'No nonce-bound receiver means no automatic recovery');
console.log('Bounded workflow response-stream recovery checks passed.');
