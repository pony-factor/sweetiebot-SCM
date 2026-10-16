'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function run() {
  const clipboard = [];
  const commands = [];
  const vscodeStub = {
    Uri: {
      parse(value) { return {path: String(value).replace(/^file:\/\//, '')}; },
      from(parts) { return {toString: () => `${parts.scheme}://${parts.authority}${parts.path}`}; }
    },
    env: {
      uriScheme: 'vscode',
      clipboard: {async writeText(value) { clipboard.push(value); }}
    },
    commands: {async executeCommand(command, uri) {commands.push({command, uri});}}
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
  provider.lastResults = [{kind: 'folder', uri: 'file:///tmp/research', relative: 'research', line: 0}];
  await provider.onMessage({type: 'copyPath', index: 0});
  assert.equal(clipboard[1], '[research](vscode://file/tmp/research)', 'Folder links must not append a line number');
  await provider.onMessage({type: 'open', index: 0});
  assert.equal(commands.at(-1).command, 'revealInExplorer', 'Opening a folder result reveals it in Explorer');
  assert.equal(commands.at(-1).uri.path, '/tmp/research');

  const makeNode = tagName => ({
    tagName, children: [], dataset: {}, listeners: {},
    addEventListener(event, listener) { this.listeners[event] = listener; },
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    setAttribute(name, value) { this[name] = value; },
    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (selector === '[data-index]' && Object.hasOwn(node.dataset, 'index')) return node;
      }
      return null;
    },
    remove() { this.removed = true; }
  });
  const elements = new Map();
  for (const id of ['search', 'query', 'clear-query', 'mode', 'status', 'answer', 'results', 'summary', 'idle']) {
    elements.set(id, Object.assign(makeNode(id), {value: id === 'mode' ? 'hybrid' : '', focus() {}}));
  }
  const windowListeners = {};
  const timers = new Map(); let nextTimer = 0; const sent = [];
  const html = provider.html({cspSource: 'test'});
  assert.match(html, /placeholder="Search your workspace…"/);
  const customProvider = new sandbox.module.exports.WorkspaceSearchViewProvider({}, () => ({placeholder: 'SATS "targets" & <files>'}));
  const customHtml = customProvider.html({cspSource: 'test'});
  assert.match(customHtml, /placeholder="SATS &quot;targets&quot; &amp; &lt;files&gt;"/);
  assert.match(customHtml, /aria-label="Search your workspace"/);
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
  assert.match(html, /\.file-heading:hover\{background:var\(--vscode-list-hoverBackground\)\}/);
  assert.match(html, /\.file-heading:focus-visible\{outline:1px solid var\(--vscode-focusBorder\)/);
  assert.match(html, /group\.entries\[0\]\?\.result\?\.kind==='folder'/);
  assert.match(html, /if\(result\.kind!=='folder'\)meta\.append\(line\)/);
  assert.match(html, /id="summary" class="result-summary"/);
  assert.match(html, /' across '\+fileCount\+' file'/);
  assert.match(html, /' and '\+folderCount\+' folder'/);
  assert.doesNotMatch(html, /' · '\+message\.mode/);
  assert.match(html, /className='line-number'/);
  assert.match(html, /meta\.append\(score,copied\)/);
  assert.match(html, /slice\(0,MAX_RESULTS_PER_FILE\)/);
  assert.match(html, /more\.textContent='…'/);
  const page = {document: {getElementById: id => elements.get(id), createElement: makeNode},
    acquireVsCodeApi: () => ({postMessage: message => sent.push(message)}),
    setTimeout: (callback, delay) => {assert.equal(delay, 350); timers.set(++nextTimer, callback); return nextTimer;},
    clearTimeout: id => timers.delete(id), window: {addEventListener(event, listener) { windowListeners[event] = listener; }}};
  vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], page);
  assert.equal(page.contrastCheckColor('rgb(255, 255, 255)'), '#000');
  assert.equal(page.contrastCheckColor('rgba(0, 0, 0, 0.5)'), '#fff');
  const query = elements.get('query'); const clearQuery = elements.get('clear-query'); const form = elements.get('search'); const idle = elements.get('idle');
  windowListeners.message({data: {type: 'placeholder', value: 'SATS'}});
  assert.equal(query.placeholder, 'SATS', 'changing the search hint does not rebuild or clear the view');
  windowListeners.message({data: {type: 'placeholder', value: ''}});
  assert.equal(query.placeholder, 'Search your workspace…', 'blank custom hints restore the original');
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
  let pastePrevented = false;
  query.value = 'stale';
  windowListeners.paste({target: query, clipboardData: {getData: () => 'fresh'}, preventDefault() { pastePrevented = true; }});
  assert.equal(pastePrevented, true, 'panel-level paste overrides the existing query even though the field was auto-focused');
  assert.equal(query.value, 'fresh');
  query.listeners.pointerdown();
  pastePrevented = false;
  windowListeners.paste({target: query, clipboardData: {getData: () => ' additive'}, preventDefault() { pastePrevented = true; }});
  assert.equal(pastePrevented, false, 'paste stays native while the user is actively editing the query field');
  query.listeners.blur();

  windowListeners.message({data: {type: 'results', results: [
    {uri: 'file:///tmp/src/foo.js', relative: 'src/foo.js', text: 'first match', score: .9, line: 3},
    {uri: 'file:///tmp/src/foo.js', relative: 'src/foo.js', text: 'second match', score: .7, line: 8},
    {kind: 'folder', uri: 'file:///tmp/src', relative: 'src', text: 'directory', score: .6, line: 0}
  ]}});
  const sections = elements.get('results').children;
  assert.equal(sections.length, 2, 'multiple hits for one file share a clickable heading');
  const fileHeading = sections[0].children[0];
  assert.equal(fileHeading.tagName, 'button', 'file headings are keyboard-accessible buttons');
  assert.equal(fileHeading.dataset.index, '0', 'file headings open the top-ranked hit');
  assert.equal(fileHeading['aria-label'], 'Open src/foo.js');
  for (const target of [fileHeading.children[1], fileHeading.children[2]]) {
    elements.get('results').listeners.click({target});
    assert.equal(sent.at(-1).type, 'open', 'clicking the file route or filename opens the result');
    assert.equal(sent.at(-1).index, 0);
  }
  const folderHeading = sections[1].children[0];
  assert.equal(folderHeading.dataset.index, '2');
  elements.get('results').listeners.click({target: folderHeading.children[1]});
  assert.equal(sent.at(-1).type, 'open', 'folder headings still use the existing reveal action');
  assert.equal(sent.at(-1).index, 2);
  console.log('Workspace search debounce, submit, composition, clear, file-heading click, and stale-response checks passed.');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
