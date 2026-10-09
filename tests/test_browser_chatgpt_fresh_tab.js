'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname,
  '../assets/browser/chatgpt_fresh_tab.js'), 'utf8');
const DRAFT = 'oai/apps/lightweight-web/composerDraft/v1';

function open(url, storage = new Map([[DRAFT, 'An unsent draft'], ['other-key', 'keep']]),
    { blockedStorage = false, iframe = false } = {}) {
  const removed = [];
  const window = { location: new URL(url) };
  window.top = iframe ? {} : window;
  window.localStorage = {
    removeItem(key) {
      if (blockedStorage) throw new Error('Storage blocked');
      removed.push(key); storage.delete(key);
    }
  };
  const history = {
    state: {},
    replaceState(_state, _title, destination) { window.location = new URL(destination); }
  };
  vm.runInNewContext(source, { window, history, URL });
  return { storage, removed, url: window.location.href };
}

let state = open('https://chatgpt.com/?sweetiebot_fresh=1');
assert.deepEqual(state.removed, [DRAFT]);
assert.equal(state.storage.has(DRAFT), false);
assert.equal(state.storage.get('other-key'), 'keep');
assert.equal(state.url, 'https://chatgpt.com/');

state = open('https://chatgpt.com/g/g-p-example/project?sweetiebot_fresh=1');
assert.deepEqual(state.removed, [DRAFT]);
assert.equal(state.url, 'https://chatgpt.com/g/g-p-example/project');

for (const url of [
  'https://chatgpt.com/',
  'https://chatgpt.com/?q=Write%20a%20PR&sweetiebot_fresh=1',
  'https://chatgpt.com/c/123?sweetiebot_fresh=1',
  'https://example.com/?sweetiebot_fresh=1',
  'https://chatgpt.com/?sweetiebot_fresh=0'
]) {
  state = open(url);
  assert.deepEqual(state.removed, [], url);
  assert.equal(state.storage.get(DRAFT), 'An unsent draft', url);
  assert.equal(state.url, url);
}
state = open('https://chatgpt.com/?sweetiebot_fresh=1', undefined, { iframe: true });
assert.deepEqual(state.removed, []);
state = open('https://chatgpt.com/?sweetiebot_fresh=1', undefined, { blockedStorage: true });
assert.deepEqual(state.removed, []);
assert.equal(state.storage.get(DRAFT), 'An unsent draft');
console.log('Fresh ChatGPT browser-tab draft isolation checks passed.');
