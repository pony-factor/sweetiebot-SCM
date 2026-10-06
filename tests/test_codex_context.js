'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(name, context) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/codex', name), 'utf8'), context);
}

async function run() {
  const conversationId = '019c56c3-06fc-7db3-a928-9c3607e17129';
  let receive;
  const responses = [];
  const transcripts = [
    { innerText: 'Other hidden chat', getClientRects: () => [] },
    { innerText: 'Current window conversation', getClientRects: () => [1] }
  ];
  const context = vm.createContext({
    window: {
      location: { hash: `#/local/${conversationId}`, pathname: '/', search: '' },
      addEventListener(type, listener) { assert.equal(type, 'message'); receive = listener; }
    },
    document: {
      querySelectorAll(selector) {
        if (selector === '[data-thread-user-message-navigation-content]') return transcripts;
        if (selector.includes('[data-conversation-id]')) return [];
        throw new Error(`Unexpected selector: ${selector}`);
      }
    }
  });
  load('codex-context-webview.js', context);
  context.scmToolkitRegisterCodexSnapshot({ postMessage: message => responses.push(message) });
  receive({ data: { type: 'unrelated' } });
  assert.equal(responses.length, 0);
  receive({ data: { type: 'scm-toolkit-context-request', id: 'request' } });
  assert.equal(responses[0].text, 'Current window conversation');
  assert.equal(responses[0].conversationId, conversationId);

  transcripts.splice(0, transcripts.length, {
    innerText: 'Retained hidden chat',
    getClientRects: () => []
  });
  receive({ data: { type: 'scm-toolkit-context-request', id: 'hidden' } });
  assert.equal(responses[1].text, 'Retained hidden chat');

  const registered = new Map();
  let listener;
  const messages = [];
  const webview = {
    onDidReceiveMessage(callback) { listener = callback; return { dispose() {} }; },
    async postMessage(message) { messages.push(message); return true; }
  };
  const provider = {
    editorPanels: new Map(),
    sidebarViews: new Set([{ visible: true, webview }]),
    initializeWebview() {},
    handleMessage() { throw new Error('Custom snapshot replies must not reach Codex job handling'); }
  };
  const host = vm.createContext({ require, setTimeout, clearTimeout, encodeURIComponent });
  load('codex-context-host.js', host);
  const disposable = host.scmToolkitRegisterCodexSnapshotProvider(provider, {
    commands: {
      registerCommand(id, callback) {
        registered.set(id, callback);
        return { dispose() {} };
      }
    }
  });
  assert(registered.has('scmToolkit.readCodexContext'));
  assert(registered.has('scmToolkit.readCodexConversation'));

  provider.initializeWebview(webview, 'sidebar', () => {});
  const closedPanel = { get active() { throw new Error('Webview is disposed'); } };
  provider.editorPanels.set(closedPanel, {});
  provider.getWebviewForPanel = () => undefined;

  const textPending = registered.get('scmToolkit.readCodexContext')();
  assert.equal(messages[0].type, 'scm-toolkit-context-request');
  listener({
    type: 'scm-toolkit-context-response',
    id: messages[0].id,
    text: 'Window-local text',
    conversationId
  });
  assert.equal(await textPending, 'Window-local text');

  const sourcePending = registered.get('scmToolkit.readCodexConversation')();
  listener({
    type: 'scm-toolkit-context-response',
    id: messages[1].id,
    text: 'Window-local source text',
    conversationId
  });
  const snapshot = await sourcePending;
  assert.equal(snapshot.text, 'Window-local source text');
  assert.equal(snapshot.source.kind, 'codex');
  assert.equal(snapshot.source.uuid, conversationId);
  assert.match(snapshot.source.url, /^https:\/\/vscode\.dev\/redirect\?url=/);
  assert(snapshot.source.url.includes(conversationId));

  provider.handleMessage(webview, { type: 'scm-toolkit-context-response' });
  assert.equal(messages.length, 2, 'no submit or interrupt messages are sent');

  const sidebar = [...provider.sidebarViews][0];
  sidebar.visible = false;
  const hiddenPending = registered.get('scmToolkit.readCodexContext')();
  listener({
    type: 'scm-toolkit-context-response',
    id: messages[2].id,
    text: 'Retained conversation',
    conversationId
  });
  assert.equal(await hiddenPending, 'Retained conversation', 'Source Control can hide Codex without losing context');

  provider.sidebarViews.clear();
  assert.throws(
    () => registered.get('scmToolkit.readCodexConversation')(),
    /Open a Codex conversation/
  );
  disposable.dispose();
  console.log('Read-only Codex snapshot and provenance bridge checks passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
