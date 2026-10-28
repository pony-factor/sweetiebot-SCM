'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function run() {
  const clipboard = [];
  const commands = [];
  const decorations = [];
  const opened = [];
  const lines = [
    'Preface.',
    'A long paragraph that hides the needle in the surrounding text.',
    'A completely unrelated paragraph.',
    'The alpha and beta terms are both here, followed by alpha again.',
    'A semantic-only passage without a matching phrase.'
  ];
  const document = {lineCount: lines.length, lineAt(index) { return {text: lines[index]}; }};
  let editorChangeListener;
  class Range {
    constructor(startLine, startColumn, endLine, endColumn) {
      this.start = {line: startLine, character: startColumn};
      this.end = {line: endLine, character: endColumn};
    }
  }
  const editor = {
    document,
    setDecorations(type, ranges) { decorations.push({type, ranges}); },
    revealRange(range) { this.revealed = range; }
  };
  const vscodeStub = {
    Range,
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    OverviewRulerLane: {Center: 2},
    TextEditorRevealType: {InCenterIfOutsideViewport: 2},
    workspace: {async openTextDocument() { return document; }, getWorkspaceFolder() {return {uri: {scheme: 'file', fsPath: '/tmp/repo'}};}}, 
    window: {
      activeTextEditor: undefined,
      async showTextDocument(_document, options) { opened.push(options); return editor; },
      createTextEditorDecorationType(options) { return {options, dispose() {this.disposed = true;}}; },
      onDidChangeActiveTextEditor(listener) {
        editorChangeListener = listener;
        return {dispose() {editorChangeListener = undefined;}};
      }
    },
    Uri: {
      parse(value) {
        const pathname = decodeURIComponent(String(value).replace(/^file:\/\//, ''));
        return {scheme: 'file', path: pathname, fsPath: pathname};
      }
    },
    env: {
      uriScheme: 'vscode',
      clipboard: {async writeText(value) { clipboard.push(value); }}
    },
    commands: {async executeCommand(command, uri) {commands.push({command, uri});}}
  };
  const sandbox = { module: { exports: {} }, require(name) {
    if (name === 'vscode') return vscodeStub;
    if (name === './extract') return { TEXT_EXTENSIONS: new Set(['.txt', '.md']) };
    if (name === './ollama') return {};
    return require(name);
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/search/view'), 'utf8'), sandbox);
  const {groupSearchResults, splitResultPath, formatResultScore, scoreIconSize} = sandbox.module.exports;
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
  const githubRequests = [];
  const githubProvider = new sandbox.module.exports.WorkspaceSearchViewProvider(
    {search: async () => ({results: []})}, () => ({}),
    {search: async (query, mode) => {
      githubRequests.push({query, mode});
      return {results: [{relative: 'repo/Wormhole.md'}], warning: '', mode};
    }}
  );
  githubProvider.view = {webview: {postMessage() {}}};
  await githubProvider.onMessage({type: 'search', query: 'Wormhole', mode: 'exact', scope: 'github', requestId: 1});
  assert.equal(githubRequests.length, 1);
  assert.equal(githubProvider.lastResults[0].relative, 'repo/Wormhole.md');
  assert.equal(scoreIconSize(0, 3), 12);
  assert.equal(scoreIconSize(3, 3), 30);
  assert.ok(scoreIconSize(.9, .9) > scoreIconSize(.7, .9), 'stronger matches have larger icons');
  assert.equal(scoreIconSize(NaN, 3), 12, 'invalid scores use the smallest icon');
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

  const gitCalls = [];
  provider.findGitRoot = async (...args) => {gitCalls.push(args); return '/tmp/repo';};
  provider.lastResults = [{uri: 'file:///tmp/repo/references/aguliar.md', relative: 'references/aguliar.md', line: 6}];
  await provider.onMessage({type: 'copyPath', index: 0});
  assert.equal(clipboard[0], '[references/aguliar.md:7](/references/aguliar.md#L7)',
    'Links from the repository workspace root must work in any file in the repo');
  assert.equal(messages.at(-1).type, 'copied');
  assert.equal(messages.at(-1).index, 0);
  assert.doesNotMatch(clipboard[0], /vscode:\/\/file|\/tmp\/repo/);

  // When the workspace is a parent GitHub directory, VS Code resolves a
  // leading slash against that parent instead. Link from the active Markdown
  // document when it lives in the same repository.
  vscodeStub.workspace.getWorkspaceFolder = () => ({uri: {scheme: 'file', fsPath: '/tmp'}});
  vscodeStub.window.activeTextEditor = {document: {uri: {scheme: 'file', fsPath: '/tmp/repo/notes/draft.md'}}};
  await provider.onMessage({type: 'copyPath', index: 0});
  assert.equal(clipboard[1], '[references/aguliar.md:7](../references/aguliar.md#L7)');
  vscodeStub.window.activeTextEditor = {document: {uri: {scheme: 'file', fsPath: '/tmp/another-repo/draft.md'}}};
  await provider.onMessage({type: 'copyPath', index: 0});
  assert.equal(clipboard[2], '[references/aguliar.md:7](/references/aguliar.md#L7)',
    'The active editor in a different repository must not determine the relative path');

  provider.lastResults = [{kind: 'folder', uri: 'file:///tmp/repo/research', relative: 'research', line: 0}];
  await provider.onMessage({type: 'copyPath', index: 0});
  assert.equal(clipboard[3], '[research](/research)', 'Folder links must not append a line number');
  assert.equal(gitCalls.at(-1)[1], true, 'Folders use their own path when resolving the Git root');
  await provider.onMessage({type: 'open', index: 0});
  assert.equal(commands.at(-1).command, 'revealInExplorer', 'Opening a folder result reveals it in Explorer');
  assert.equal(commands.at(-1).uri.path, '/tmp/repo/research');

  provider.lastResults = [{uri: 'file:///tmp/repo/core%20refs/file%20(1)%23.md', relative: 'core refs/file (1)#.md', line: 0}];
  await provider.onMessage({type: 'copyPath', index: 0});
  assert.equal(clipboard[4], '[core refs/file (1)#.md:1](/core%20refs/file%20%281%29%23.md#L1)',
    'Spaces, parentheses, and literal hashes in filenames must be URL-encoded');

  provider.findGitRoot = async () => {throw new Error('not a git repository');};
  const before = clipboard.length;
  await provider.onMessage({type: 'copyPath', index: 0});
  assert.equal(clipboard.length, before, 'Failure must not copy an absolute private filesystem path');
  assert.equal(messages.at(-1).type, 'error');

  // Opening a passage must outline the target line and mark the actual text.
  provider.lastQuery = 'needle';
  provider.lastResults = [{uri: 'file:///tmp/new.txt', relative: 'new.txt', line: 1, text: lines[1]}];
  await provider.onMessage({type: 'open', index: 0});
  assert.equal(opened.at(-1).selection.start.line, 1);
  assert.equal(opened.at(-1).selection.start.character, lines[1].indexOf('needle'),
    'the cursor should land at the matching word, not column zero');
  assert.equal(decorations.at(-2).ranges[0].start.line, 1, 'outline the selected passage line');
  assert.equal(decorations.at(-1).ranges[0].start.character, lines[1].indexOf('needle'),
    'highlight the matching text inside the line');
  assert.equal(decorations.at(-1).type.options.borderColor.id, 'editor.findMatchBorder');
  assert.equal(editor.revealed.start.line, 1, 'reveal the matched line in the editor');

  provider.lastQuery = 'alpha beta';
  provider.lastResults[0].line = 3;
  await provider.onMessage({type: 'open', index: 0});
  assert.equal(decorations.at(-1).ranges.length, 3, 'mark all matching terms when a full phrase is absent');

  provider.lastQuery = 'synonym not present';
  provider.lastResults[0].line = 4;
  await provider.onMessage({type: 'open', index: 0});
  assert.equal(decorations.at(-2).ranges[0].start.line, 4, 'semantic-only hits still outline their line');
  assert.equal(decorations.at(-1).ranges.length, 0, 'do not invent a textual match for semantic results');

  provider.lastResults[0] = {kind: 'filename', uri: 'file:///tmp/new.txt', relative: 'new.txt', line: 0};
  await provider.onMessage({type: 'open', index: 0});
  assert.equal(opened.at(-1).selection.start.line, 0);
  assert.equal(decorations.at(-1).ranges.length, 0, 'filename-only hits must clear passage highlights');
  provider.lastResults[0] = {uri: 'file:///tmp/new.txt', line: 1};
  provider.lastQuery = 'needle';
  await provider.onMessage({type: 'open', index: 0});
  editorChangeListener(undefined);
  assert.equal(decorations.at(-1).ranges.length, 0, 'navigating away clears the temporary highlight');
  provider.dispose();
  assert.equal(editorChangeListener, undefined, 'provider disposal releases editor listeners');

  const makeNode = tagName => ({
    tagName, children: [], dataset: {}, listeners: {}, style: {setProperty(name, value) {this[name] = value;}},
    addEventListener(event, listener) { this.listeners[event] = listener; },
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    setAttribute(name, value) { this[name] = value; },
    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (selector === '[data-index]' && Object.hasOwn(node.dataset, 'index')) return node;
        if (selector === '[data-history-index]' && Object.hasOwn(node.dataset, 'historyIndex')) return node;
      }
      return null;
    },
    remove() { this.removed = true; }
  });
  const elements = new Map();
  for (const id of ['search', 'query', 'clear-query', 'mode', 'scope', 'score-toggle', 'status', 'answer', 'results', 'summary', 'idle', 'history-toggle', 'history-panel', 'history-list', 'history-clear']) {
    elements.set(id, Object.assign(makeNode(id), {value: id === 'mode' ? 'hybrid' : id === 'scope' ? 'workspace' : '', focus() {}}));
  }
  const windowListeners = {};
  const timers = new Map(); let nextTimer = 0; const sent = [];let pageState;let currentTime=Date.now();
  const searchTimers=()=>[...timers.entries()].filter(([,entry])=>entry.delay===350);
  class PageDate extends Date {static now(){return currentTime;}}
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
  assert.match(html, /id="history-toggle"/);
  assert.match(html, /id="score-toggle" class="score-toggle"/);
  assert.match(html, /#results\.score-icons-active \.score\{display:none\}/);
  assert.match(html, /id="history-panel"/);
  assert.match(html, /id="history-clear"/);
  assert.match(html, /INACTIVITY_MS=8\*60\*60\*1000/);
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
  assert.match(html, /meta\.append\(score,scoreIcon,copied\)/);
  assert.match(html, /slice\(0,MAX_RESULTS_PER_FILE\)/);
  assert.match(html, /more\.textContent='…'/);
  const page = {document: {getElementById: id => elements.get(id), createElement: makeNode,
    addEventListener(event, listener) {windowListeners[event] = listener;}},
    Date: PageDate,
    acquireVsCodeApi: () => ({postMessage: message => sent.push(message),
      getState: () => pageState, setState: value => {pageState = value;}}),
    setTimeout: (callback, delay) => {assert.ok(delay===350||(delay>0&&delay<=8*60*60*1000));timers.set(++nextTimer,{callback,delay});return nextTimer;},
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
  assert.equal(searchTimers().length, 1);
  assert.equal(sent.length, 0);
  const [firstTimerId,firstTimer]=searchTimers()[0];timers.delete(firstTimerId);firstTimer.callback();
  assert.equal(sent[0].query, 'apple');
  query.value = 'orchard'; query.listeners.input();
  form.listeners.submit({preventDefault() {}});
  assert.equal(searchTimers().length, 0, 'Enter/icon submit cancels the pending automatic search');
  assert.equal(sent[1].query, 'orchard');
  query.listeners.compositionstart(); query.value = 'composing'; query.listeners.input();
  assert.equal(searchTimers().length, 0);
  query.listeners.compositionend(); assert.equal(searchTimers().length, 1);
  clearQuery.listeners.click();
  assert.equal(query.value, '');
  assert.equal(clearQuery.hidden, true, 'clear control hides after clearing');
  assert.equal(idle.hidden, false, 'logo returns after the search term is cleared');
  assert.equal(searchTimers().length, 0); assert.equal(sent.at(-1).query, '');
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

  assert.ok(pageState.history.some(entry=>entry.query==='orchard'&&entry.mode==='hybrid'),'submitted searches are saved');
  assert.ok(pageState.history.some(entry=>entry.query==='apples'&&entry.mode==='exact'),'search modes are saved');
  elements.get('history-toggle').listeners.click();
  assert.equal(elements.get('history-toggle')['aria-expanded'],'true');
  assert.ok(elements.get('history-list').children.length>=2);
  const recent=elements.get('history-list').children[0];
  elements.get('history-list').listeners.click({target:recent});
  assert.equal(sent.at(-1).query,recent.children[0].textContent,'choosing a recent query searches again');
  assert.equal(elements.get('history-panel').hidden,true);
  query.value='still showing';windowListeners.pointerdown();
  currentTime+=8*60*60*1000+1;
  windowListeners.focus();
  assert.equal(query.value,'','the search query expires after eight hours of inactivity');
  assert.equal(elements.get('results').children.length,0);
  assert.equal(sent.at(-1).query,'','idle expiry cancels any pending search');
  assert.ok(pageState.history.length>0,'history is preserved after panel expiry');
  elements.get('history-toggle').listeners.click();
  elements.get('history-clear').listeners.click();
  assert.equal(pageState.history.length,0,'history can be cleared on demand');
  assert.equal(elements.get('history-list').children[0].textContent,'No recent searches.');

  windowListeners.message({data: {type: 'results', results: [
    {uri: 'file:///tmp/src/foo.js', relative: 'src/foo.js', text: 'first match', score: .9, line: 3},
    {uri: 'file:///tmp/src/foo.js', relative: 'src/foo.js', text: 'second match', score: .7, line: 8},
    {kind: 'folder', uri: 'file:///tmp/src', relative: 'src', text: 'directory', score: .6, line: 0}
  ]}});
  const sections = elements.get('results').children;
  assert.equal(sections.length, 2, 'multiple hits for one file share a clickable heading');
  const firstScoreIcon = sections[0].children[1].children[0].children[1].children[2];
  const secondScoreIcon = sections[0].children[1].children[1].children[1].children[2];
  assert.equal(firstScoreIcon.className, 'score-icon');
  assert.equal(firstScoreIcon['aria-label'], 'Relevance .90');
  assert.ok(parseInt(firstScoreIcon.style['--score-size']) > parseInt(secondScoreIcon.style['--score-size']));
  const scoreToggle = elements.get('score-toggle');
  assert.equal(scoreToggle['aria-pressed'], 'false', 'numerical scores remain the default');
  const beforeToggleMessages = sent.length;
  scoreToggle.listeners.click();
  assert.equal(scoreToggle['aria-pressed'], 'true');
  assert.equal(elements.get('results').className, 'score-icons-active');
  assert.equal(pageState.useScoreIcons, true, 'score display preference persists alongside search history');
  assert.equal(sent.length, beforeToggleMessages, 'switching score displays does not rerun search');
  scoreToggle.listeners.click();
  assert.equal(elements.get('results').className, '');
  assert.equal(pageState.useScoreIcons, false);
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
