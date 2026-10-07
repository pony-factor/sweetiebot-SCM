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
  const {groupSearchResults, splitResultPath, formatResultScore} = sandbox.module.exports;
  const grouped = groupSearchResults([
    {uri: 'file:///top/a.md', relative: 'top/a.md', score: .99},
    {uri: 'file:///other/b.md', relative: 'other/b.md', score: .91},
    {uri: 'file:///top/a.md', relative: 'top/a.md', score: .80}
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].relative, 'top/a.md', 'the file containing the highest-ranked result stays first');
  assert.equal(grouped[0].entries.length, 2);
  assert.equal(grouped[0].entries[0].index, 0);
  assert.equal(grouped[0].entries[1].index, 2, 'grouped entries keep their original score order and open index');
  assert.equal(splitResultPath('src/search/view.js').folders.join('/'), 'src/search');
  assert.equal(splitResultPath('src/search/view.js').filename, 'view.js');
  assert.equal(formatResultScore(.87), '.87');
  assert.equal(formatResultScore(1), '1.00');
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
  for (const id of ['search', 'query', 'clear-query', 'mode', 'status', 'answer', 'results', 'summary', 'idle']) {
    elements.set(id, {value: id === 'mode' ? 'hybrid' : '', listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; },
      replaceChildren() {}, focus() {}});
  }
  const timers = new Map(); let nextTimer = 0; const sent = [];
  const html = provider.html({cspSource: 'test'});
  assert.match(html, /class="search-input".*id="clear-query".*class="search-button"/);
  assert.match(html, /copy-status\.copied/);
  assert.match(html, /contrastCheckColor/);
  assert.match(html, /message\.type==='copied'/);
  assert.match(html, /id="idle" class="idle-mark"/);
  assert.match(html, /align-items:center;justify-content:center/);
  assert.match(html, /opacity:\.13;filter:blur\(\.65px\)/);
  assert.match(html, /min-width:112px/);
  assert.match(html, /function updateIdleState\(\)/);
  assert.match(html, /function updateQueryControls\(\)/);
  assert.match(html, /let searching=false/);
  assert.match(html, /idle\.hidden=Boolean\(query\.value\.trim\(\)\)&&!searching/);
  assert.match(html, /message\.type==='results'\)\{searching=false;updateIdleState\(\)/);
  assert.match(html, /MAX_RESULTS_PER_FILE=7/);
  assert.match(html, /className='folder-tree'/);
  assert.match(html, /className='folder-route'/);
  assert.match(html, /className='file-name'/);
  assert.match(html, /id="summary" class="result-summary"/);
  assert.match(html, /' across '\+groups\.length\+' file'/);
  assert.doesNotMatch(html, /' · '\+message\.mode/);
  assert.match(html, /className='line-number'/);
  assert.match(html, /meta\.append\(line,score,copied\)/);
  assert.match(html, /slice\(0,MAX_RESULTS_PER_FILE\)/);
  assert.match(html, /more\.textContent='…'/);
  const page = {document: {getElementById: id => elements.get(id)},
    acquireVsCodeApi: () => ({postMessage: message => sent.push(message)}),
    setTimeout: (callback, delay) => {assert.equal(delay, 350); timers.set(++nextTimer, callback); return nextTimer;},
    clearTimeout: id => timers.delete(id), window: {addEventListener() {}}};
  vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], page);
  assert.equal(page.contrastCheckColor('rgb(255, 255, 255)'), '#000');
  assert.equal(page.contrastCheckColor('rgba(0, 0, 0, 0.5)'), '#fff');
  const query = elements.get('query'); const clearQuery = elements.get('clear-query'); const form = elements.get('search'); const idle = elements.get('idle');
  assert.equal(idle.hidden, false, 'logo is visible when the search term is empty');
  assert.equal(clearQuery.hidden, true, 'clear control starts hidden');
  query.value = 'app'; query.listeners.input();
  assert.equal(idle.hidden, false, 'logo stays visible while a search is pending');
  assert.equal(clearQuery.hidden, false, 'clear control appears when the query has text');
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
  clearQuery.listeners.click();
  assert.equal(query.value, '');
  assert.equal(clearQuery.hidden, true, 'clear control hides after clearing');
  assert.equal(idle.hidden, false, 'logo returns after the search term is cleared');
  assert.equal(timers.size, 0); assert.equal(sent.at(-1).query, '');
  elements.get('mode').value = 'exact'; query.value = 'apples';
  elements.get('mode').listeners.change(); assert.equal(sent.at(-1).mode, 'exact');
  console.log('Workspace search debounce, submit, composition, clear, and stale-response checks passed.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
