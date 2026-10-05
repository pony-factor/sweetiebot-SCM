'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(name, context) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex', name), 'utf8'), context);
}

async function run() {
  let receive;
  const responses = [];
  const context = vm.createContext({
    window: { addEventListener(type, listener) { assert.equal(type, 'message'); receive = listener; } },
    document: { querySelectorAll(selector) {
      assert.equal(selector, '[data-thread-user-message-navigation-content]');
      return [{ innerText: 'Other hidden chat', getClientRects: () => [] },
        { innerText: 'Current window conversation', getClientRects: () => [1] }];
    } }
  });
  load('codex-context-webview.js', context);
  context.scmToolkitRegisterCodexSnapshot({ postMessage: message => responses.push(message) });
  receive({ data: { type: 'unrelated' } });
  assert.equal(responses.length, 0);
  receive({ data: { type: 'scm-toolkit-context-request', id: 'request' } });
  assert.equal(responses[0].text, 'Current window conversation');
  context.document.querySelectorAll = () => [{ innerText: 'Retained hidden chat', getClientRects: () => [] }];
  receive({ data: { type: 'scm-toolkit-context-request', id: 'hidden' } });
  assert.equal(responses[1].text, 'Retained hidden chat');

  let registered;
  let listener;
  const messages = [];
  const webview = {
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(message) { messages.push(message); return true; }
  };
  const provider = {
    editorPanels: new Map(), sidebarViews: new Set([{ visible: true, webview }]),
    initializeWebview() {}, handleMessage() { throw new Error('Custom snapshot replies must not reach Codex job handling'); }
  };
  const host = vm.createContext({ require, setTimeout, clearTimeout });
  load('codex-context-host.js', host);
  const disposable = host.scmToolkitRegisterCodexSnapshotProvider(provider, {
    commands: { registerCommand(id, callback) {
      assert.equal(id, 'scmToolkit.readCodexContext'); registered = callback; return { dispose() {} };
    } }
  });
  provider.initializeWebview(webview, 'sidebar', () => {});
  const closedPanel = { get active() { throw new Error('Webview is disposed'); } };
  provider.editorPanels.set(closedPanel, {});
  provider.getWebviewForPanel = () => undefined;
  const pending = registered();
  assert.equal(messages[0].type, 'scm-toolkit-context-request');
  listener({ type: 'scm-toolkit-context-response', id: messages[0].id, text: 'Window-local text' });
  assert.equal(await pending, 'Window-local text');
  provider.handleMessage(webview, { type: 'scm-toolkit-context-response' });
  assert.equal(messages.length, 1, 'no submit or interrupt messages are sent');
  const sidebar = [...provider.sidebarViews][0];
  sidebar.visible = false;
  const hiddenPending = registered();
  listener({ type: 'scm-toolkit-context-response', id: messages[1].id, text: 'Retained conversation' });
  assert.equal(await hiddenPending, 'Retained conversation', 'Source Control can hide Codex without losing context');
  provider.sidebarViews.clear();
  await assert.rejects(registered(), /Open a Codex conversation/);
  disposable.dispose();
  console.log('Read-only Codex snapshot bridge checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
