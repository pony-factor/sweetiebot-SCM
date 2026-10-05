'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function run() {
  const clipboard = [];
  const vscodeStub = {
    Uri: {
      parse(value) { return {path: String(value).replace(/^file:\/\//, '')}; },
      from(parts) { return {toString: () => `${parts.scheme}://${parts.authority}${parts.path}`}; }
    },
    env: {
      uriScheme: 'vscode',
      clipboard: {async writeText(value) { clipboard.push(value); }}
    }
  };
  const sandbox = { module: { exports: {} }, require(name) {
    if (name === 'vscode') return vscodeStub;
    if (name === './extract') return { TEXT_EXTENSIONS: new Set() };
    if (name === './ollama') return {};
    return require(name);
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../efs/view'), 'utf8'), sandbox);
  const pending = [];
  const provider = new sandbox.module.exports.WorkspaceSearchViewProvider({
    search: () => new Promise((resolve, reject) => pending.push({resolve, reject}))
  }, () => ({}));
  const messages = [];
  provider.view = {webview: {postMessage: message => messages.push(message)}};
  const oldSearch = provider.onMessage({type: 'search', query: 'old', requestId: 1});
  const newSearch = provider.onMessage({type: 'search', query: 'new', requestId: 2});
  pending[1].resolve({results: [{relative: 'new.txt'}]});
  await newSearch;
  pending[0].resolve({results: [{relative: 'old.txt'}]});
  await oldSearch;
  assert.equal(messages.filter(m => m.type === 'results').length, 1);
  assert.equal(provider.lastResults[0].relative, 'new.txt');
  const canceled = provider.onMessage({type: 'search', query: 'cancel', requestId: 3});
  await provider.onMessage({type: 'search', query: '', requestId: 4});
  pending[2].reject(new Error('stale error'));
  await canceled;
  assert.equal(messages.filter(m => m.type === 'error').length, 0);
  assert.equal(provider.lastResults.length, 0);

  provider.lastResults = [{uri: 'file:///tmp/new.txt', relative: 'new.txt', line: 4}];
  await provider.onMessage({type: 'copyPath', index: 0});
  assert.equal(clipboard[0], '[new.txt:5](vscode://file/tmp/new.txt:5)');
  assert.equal(messages.at(-1).type, 'copied');
  assert.equal(messages.at(-1).index, 0);

  const elements = new Map();
  for (const id of ['search', 'query', 'mode', 'status', 'answer', 'results']) {
    elements.set(id, {value: id === 'mode' ? 'hybrid' : '', listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; },
      replaceChildren() {}, focus() {}});
  }
  const timers = new Map(); let nextTimer = 0; const sent = [];
  const html = provider.html({cspSource: 'test'});
  assert.match(html, /class="search-input".*class="search-button"/);
  assert.match(html, /copy-status\.copied/);
  assert.match(html, /contrastCheckColor/);
  assert.match(html, /message\.type==='copied'/);
  const page = {document: {getElementById: id => elements.get(id)},
    acquireVsCodeApi: () => ({postMessage: message => sent.push(message)}),
    setTimeout: (callback, delay) => {assert.equal(delay, 350); timers.set(++nextTimer, callback); return nextTimer;},
    clearTimeout: id => timers.delete(id), window: {addEventListener() {}}};
  vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], page);
  const query = elements.get('query'); const form = elements.get('search');
  query.value = 'app'; query.listeners.input();
  query.value = 'apple'; query.listeners.input();
  assert.equal(timers.size, 1);
  assert.equal(sent.length, 0);
  [...timers.values()][0](); timers.clear();
  assert.equal(sent[0].query, 'apple');
  query.value = 'orchard'; query.listeners.input();
  form.listeners.submit({preventDefault() {}});
  assert.equal(timers.size, 0, 'Enter/icon submit cancels the pending automatic search');
  assert.equal(sent[1].query, 'orchard');
  query.listeners.compositionstart(); query.value = 'composing'; query.listeners.input();
  assert.equal(timers.size, 0);
  query.listeners.compositionend(); assert.equal(timers.size, 1);
  query.value = ''; query.listeners.input();
  assert.equal(timers.size, 0); assert.equal(sent.at(-1).query, '');
  elements.get('mode').value = 'exact'; query.value = 'apples';
  elements.get('mode').listeners.change(); assert.equal(sent.at(-1).mode, 'exact');
  console.log('Workspace search debounce, submit, composition, clear, and stale-response checks passed.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
