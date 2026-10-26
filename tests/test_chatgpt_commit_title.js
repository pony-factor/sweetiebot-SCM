'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {startNativeSpellcheckBridge, registerNativeSpellcheckBridge} = require('../efs/native_spellcheck_bridge');
const {acceptableTitle, stagedDiff, registerChatgptCommitTitle} = require('../efs/chatgpt_commit_title');

function response(port, ticket, method, path, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request({host: '127.0.0.1', port, path, method, headers: {
      Authorization: 'Bearer ' + ticket,
      ...(payload === undefined ? {} : {'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)})
    }}, res => {
      const parts = [];
      res.on('data', data => parts.push(data));
      res.on('end', () => resolve({code: res.statusCode,
        data: JSON.parse(Buffer.concat(parts).toString('utf8'))}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('native Spellcheck Only follows a selected ChatGPT Project and retains authenticated transport', async () => {
  const project = 'https://chatgpt.com/g/g-p-test123/project';
  const session = await startNativeSpellcheckBridge({title: '', body: 'Fxi me.'},
    {projectUrl: project, timeoutMs: 10000});
  const url = new URL(session.url);
  assert.equal(url.origin + url.pathname, project);
  const fields = new URLSearchParams(url.hash.slice(1));
  const port = Number(fields.get('port')), ticket = fields.get('ticket');
  assert.equal((await response(port, ticket, 'GET', '/job')).code, 200);
  assert.equal((await response(port, ticket, 'POST', '/result',
    {status: 'complete', result: {title: '', body: 'Fix me.'}})).code, 200);
  assert.equal((await session.completed).body, 'Fix me.');
  await assert.rejects(startNativeSpellcheckBridge({title: '', body: 'test'},
    {projectUrl: 'https://evil.example/g/g-p-test123/project'}), /ChatGPT project URL/);
});

test('commit-title transport rejects changes to the staged diff and invalid subjects', async () => {
  const session = await startNativeSpellcheckBridge({title: '', body: 'diff --git a/x b/x'},
    {mode: 'commit-title', timeoutMs: 10000});
  const url = new URL(session.url), params = new URLSearchParams(url.hash.slice(1));
  assert.equal(params.get('mode'), 'commit-title');
  const port = Number(params.get('port')), ticket = params.get('ticket');
  assert.equal((await response(port, ticket, 'GET', '/job')).data.mode, 'commit-title');
  assert.equal((await response(port, ticket, 'POST', '/result', {
    status: 'complete', result: {title: 'Too broad', body: 'Changed diff'}
  })).code, 422);
  assert.equal((await response(port, ticket, 'POST', '/result', {
    status: 'complete', result: {title: 'Generate\nsecond line', body: ''}
  })).code, 422);
  assert.equal((await response(port, ticket, 'POST', '/result', {
    status: 'complete', result: {title: '🔩 Summarize staged changes', body: ''}
  })).code, 200);
  assert.equal((await session.completed).title, '🔩 Summarize staged changes');
});

function harness({warn = 'Send to ChatGPT', approve = 'Use title', changedInput = false} = {}) {
  const calls = [], handlers = {};
  const repository = {rootUri: {fsPath: '/sample'}, inputBox: {value: ''}};
  const vscode = {
    extensions: {getExtension: () => ({activate: async () => ({getAPI: () => ({repositories: [repository]})})})},
    commands: {
      registerCommand(name, handler) {handlers[name] = handler; return {dispose() {}};},
      async getCommands() {return ['workbench.action.browser.open'];},
      async executeCommand(name, arg) {calls.push([name, arg]);}
    },
    workspace: {getConfiguration: () => ({get: () => 'https://chatgpt.com/g/g-p-test123/project'})},
    window: {
      async showWarningMessage() {return warn;},
      async showInformationMessage() {
        if (changedInput) repository.inputBox.value = 'A newer message';
        return approve;
      }
    }
  };
  const subscriptions = [];
  let starts = 0;
  registerChatgptCommitTitle(vscode, {subscriptions}, {
    diff: async () => 'diff --git a/a b/a',
    start: async (input, options) => {
      starts++;
      assert.equal(input.body, 'diff --git a/a b/a');
      assert.equal(options.mode, 'commit-title');
      assert.match(options.projectUrl, /g-p-test123/);
      return {url: 'https://chatgpt.com/g/g-p-test123/project#launch',
        completed: Promise.resolve({title: '🧾 Generate title', body: ''}),
        cancel() {}};
    }
  });
  return {handlers, calls, repository, get starts() {return starts;}};
}

test('manual ChatGPT title generation requires consent and approval, never creates a commit', async () => {
  const app = harness();
  assert.equal(await app.handlers['sweetiebot.suggestCommitTitleWithChatGPT'](), '🧾 Generate title');
  assert.equal(app.repository.inputBox.value, '🧾 Generate title');
  assert.deepEqual(app.calls.map(x => x[0]), ['workbench.action.browser.open']);
  assert.equal(acceptableTitle('x\nsecond line'), false);
  assert.equal(acceptableTitle('🧾 Generate title'), true);
  assert.equal((await stagedDiff('/sample', async () => ({stdout: 'diff --git a/a b/a'}))),
    'diff --git a/a b/a');
  await assert.rejects(stagedDiff('/sample', async () => ({stdout: ' '})), /Stage changes/);
});

test('cancelled or stale title suggestions do not modify the Source Control field', async () => {
  const refused = harness({warn: null});
  assert.equal(await refused.handlers['sweetiebot.suggestCommitTitleWithChatGPT'](), null);
  assert.equal(refused.starts, 0);
  const declined = harness({approve: undefined});
  assert.equal(await declined.handlers['sweetiebot.suggestCommitTitleWithChatGPT'](), '🧾 Generate title');
  assert.equal(declined.repository.inputBox.value, '');
  const changed = harness({changedInput: true});
  await assert.rejects(changed.handlers['sweetiebot.suggestCommitTitleWithChatGPT'](), /message changed/);
  assert.equal(changed.repository.inputBox.value, 'A newer message');
});

test('native manual spellcheck receives the configured project destination', async () => {
  const handlers = {};
  const vscode = {
    commands: {
      registerCommand(name, fn) {handlers[name] = fn; return {dispose() {}};},
      async getCommands() {return ['workbench.action.browser.open'];},
      async executeCommand() {}
    },
    workspace: {
      getConfiguration: () => ({get: () => 'https://chatgpt.com/g/g-p-test123/project'}),
      async openTextDocument(arg) {return arg;}
    },
    window: {async showTextDocument() {}}
  };
  registerNativeSpellcheckBridge(vscode, {subscriptions: []}, async (draft, options) => {
    assert.equal(draft.body, 'Tset');
    assert.equal(options.projectUrl, 'https://chatgpt.com/g/g-p-test123/project');
    return {url: 'https://chatgpt.com/g/g-p-test123/project#launch',
      completed: Promise.resolve({title: '', body: 'Test'}), cancel() {}};
  });
  assert.equal((await handlers['sweetiebot.spellcheckWithChatGPT']('Tset')).body, 'Test');
});

test('native browser preload submits title requests within the chosen Project', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const script = fs.readFileSync(path.join(__dirname, '../assets/browser/spellcheck_bridge.js'), 'utf8');
  const session = await startNativeSpellcheckBridge({title: '', body: 'diff --git a/a b/a'},
    {mode: 'commit-title', projectUrl: 'https://chatgpt.com/g/g-p-test123/project',
      timeoutMs: 10000});
  const location = new URL(session.url);
  const sent = [], messages = [], observers = [];
  const composer = {
    isContentEditable: true, innerText: '', textContent: '',
    focus() {}, closest() {return {querySelector() {return send;}};}
  };
  const send = {
    disabled: false, isConnected: true, getClientRects() {return [1];},
    getAttribute() {return null;},
    click() {
      sent.push(composer.innerText);
      messages.push({innerText: '{"title":"🔩 Add scoped title generation","body":""}'});
      for (const observer of observers) observer.check();
    }
  };
  const document = {
    documentElement: {},
    querySelector(selector) {return selector.includes('#prompt-textarea') ? composer : null;},
    querySelectorAll(selector) {
      return selector.includes('data-message-author-role') ? messages : [];
    },
    createRange() {return {selectNodeContents() {}, collapse() {}};},
    execCommand(action, _ui, value) {
      if (action !== 'insertText') return false;
      composer.innerText += value;
      return true;
    }
  };
  const window = {location, getSelection() {return {removeAllRanges() {}, addRange() {}};}};
  window.top = window;
  const history = {state: null, replaceState(_state, _title, url) {location.href = url;}};
  class Observer {
    constructor(check) {this.check = check;}
    observe() {observers.push(this);}
    disconnect() {}
  }
  vm.runInNewContext(script, {
    window, document, history, MutationObserver: Observer,
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    Buffer, require, URL, URLSearchParams, setTimeout, clearTimeout
  }, {filename: 'spellcheck_bridge.js'});
  const result = await session.completed;
  assert.equal(result.title, '🔩 Add scoped title generation');
  assert.equal(result.body, '');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Generate one concise, specific Git commit title/);
  assert.match(sent[0], /diff --git a\/a b\/a/);
  assert.doesNotMatch(sent[0], /Spellcheck this text/);
  assert.equal(location.pathname, '/g/g-p-test123/project');
  assert.equal(location.hash, '', 'bearer credentials must not stay in browser history');
});
